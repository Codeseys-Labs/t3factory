import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

type CommandInput = {
  readonly home: string;
  readonly baseDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly isPackaged?: boolean;
  readonly distribution?: DesktopEnvironment.DesktopEnvironment["Service"]["distribution"];
};

const environmentFor = (path: Path.Path, input: CommandInput & { readonly baseDir: string }) =>
  DesktopEnvironment.DesktopEnvironment.of({
    path,
    platform: input.platform ?? "linux",
    isPackaged: input.isPackaged ?? true,
    distribution: input.distribution ?? "t3code",
    homeDirectory: input.home,
    baseDir: input.baseDir,
    stateDir: path.join(input.baseDir, "userdata"),
    serverRoot: "/opt/T3 Code/resources/app.asar",
    appImagePath: Option.none(),
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const commandIn = (
  input: CommandInput,
  spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const baseDir = input.baseDir ?? path.join(input.home, ".t3");
    yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    const make = DesktopCliCommand.make.pipe(
      Effect.provideService(
        DesktopEnvironment.DesktopEnvironment,
        environmentFor(path, { ...input, baseDir }),
      ),
    );
    return yield* spawner
      ? make.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      : make;
  });

const fakePowerShell = (initial: string) => {
  const registry = { path: initial, failReads: false, writes: 0 };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { options } = command as unknown as {
        readonly options: { readonly env?: Record<string, string> };
      };
      const env = options.env ?? {};
      let exitCode = 0;
      let stdout = "";
      if (env.T3_SET === "1") {
        registry.path = env.T3_PATH ?? "";
        registry.writes += 1;
      } else if (registry.failReads) {
        exitCode = 1;
      } else {
        stdout = Buffer.from(registry.path, "utf8").toString("base64");
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { registry, spawner };
};

// The Linux scenarios split PATH on ":", so a Windows host gets rooted entries without drive letters,
// which resolve on the current drive and come back from the PATH search in that form.
const onSearchPath = (path: Path.Path, target: string) => {
  if (HostProcess.Platform.defaultValue() !== "win32") return target;
  const { root } = path.parse(target);
  if (root.toLowerCase() !== path.parse(process.cwd()).root.toLowerCase()) {
    throw new Error(`Run these tests from the drive that holds ${target}.`);
  }
  return target.slice(root.length - 1);
};
const searchPath = (path: Path.Path, ...directories: ReadonlyArray<string>) =>
  directories.map((directory) => onSearchPath(path, directory)).join(":");

const machinePath = process.env.PATH;
beforeEach(() => {
  process.env.PATH = "";
});
afterEach(() => {
  process.env.PATH = machinePath;
});

it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
  it.effect("links the launcher onto PATH and removes only that link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const link = path.join(home, ".local", "bin", "t3");

      expect(yield* command.state).toEqual({
        supported: true,
        installedPath: null,
        onPath: false,
        launcherPath: null,
      });
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(link);
      expect(installed.launcherPath).toBe(path.join(home, ".t3", "bin", "t3"));
      expect(yield* fs.readLink(link)).toBe(path.join(home, ".t3", "bin", "t3"));
      expect((yield* command.install).installedPath).toBe(link);

      expect((yield* command.uninstall).installedPath).toBeNull();
      expect(yield* fs.exists(link)).toBe(false);
      expect(yield* fs.exists(path.join(home, ".t3", "bin", "t3"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("never replaces or removes a t3 it did not create", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const theirs = path.join(home, ".local", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.writeFileString(theirs, "npm's t3\n");
      yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
      yield* fs.symlink(path.join(home, "gone"), path.join(home, "bin", "t3"));

      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("Another t3 command is already installed");
      yield* command.uninstall;
      expect(yield* fs.readFileString(theirs)).toBe("npm's t3\n");
      expect(yield* fs.readLink(path.join(home, "bin", "t3"))).toBe(path.join(home, "gone"));

      const launcher = path.join(home, ".t3", "bin", "t3");
      yield* fs.writeFileString(launcher, "npm's t3\n");
      process.env.PATH = searchPath(path, path.dirname(launcher));
      expect(yield* command.state).toMatchObject({
        onPath: false,
        shadowedBy: onSearchPath(path, launcher),
      });
      expect((yield* Effect.flip(command.install)).message).toContain("Could not set up");
      yield* command.uninstall;
      expect(yield* fs.readFileString(launcher)).toBe("npm's t3\n");
    }).pipe(Effect.scoped),
  );

  it.effect("finds and removes a link left by a previous T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const before = yield* commandIn({ home, baseDir: path.join(home, "old-t3") });
      const link = (yield* before.install).installedPath;

      const after = yield* commandIn({ home, baseDir: path.join(home, "new-t3") });
      expect((yield* after.state).installedPath).toBe(link);
      expect((yield* after.install).installedPath).toBe(link);
      expect(yield* fs.readLink(link!)).toBe(path.join(home, "new-t3", "bin", "t3"));
      yield* after.uninstall;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "t3"))).toBe(false);
      expect(yield* fs.exists(path.join(home, "bin", "t3"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to install behind another t3 that runs first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      yield* fs.writeFileString(path.join(shadow, "t3"), "#!/bin/sh\n", { mode: 0o755 });
      process.env.PATH = searchPath(path, shadow, path.join(home, ".local", "bin"));

      const command = yield* commandIn({ home });
      const theirs = path.join(shadow, "t3");
      expect((yield* command.state).shadowedBy).toBe(onSearchPath(path, theirs));
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain(onSearchPath(path, theirs));
      expect(yield* fs.exists(path.join(home, ".local", "bin", "t3"))).toBe(false);

      yield* fs.remove(theirs);
      const installed = yield* command.install;
      expect(installed).toMatchObject({
        onPath: true,
        installedPath: path.join(home, ".local", "bin", "t3"),
      });
      expect(installed.shadowedBy).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "skips a t3 directory or a file this user cannot execute",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const folder = path.join(home, "folder");
        const plain = path.join(home, "plain");
        const shadow = path.join(home, "shadow");
        yield* fs.makeDirectory(path.join(folder, "t3"), { recursive: true });
        yield* fs.makeDirectory(plain);
        yield* fs.writeFileString(path.join(plain, "t3"), "notes\n");
        // Root can execute mode 0o601; other users must honor the owner permissions.
        yield* fs.chmod(path.join(plain, "t3"), process.getuid?.() === 0 ? 0o600 : 0o601);
        yield* fs.makeDirectory(shadow);
        yield* fs.writeFileString(path.join(shadow, "t3"), "#!/bin/sh\n", { mode: 0o755 });
        process.env.PATH = searchPath(
          path,
          folder,
          plain,
          shadow,
          path.join(home, ".local", "bin"),
        );

        const command = yield* commandIn({ home });
        expect((yield* command.state).shadowedBy).toBe(path.join(shadow, "t3"));

        const error = yield* Effect.flip(command.install);
        expect(error.message).toContain(path.join(shadow, "t3"));

        yield* fs.remove(shadow, { recursive: true });
        expect(yield* command.install).toMatchObject({
          onPath: true,
          installedPath: path.join(home, ".local", "bin", "t3"),
        });
      }).pipe(Effect.scoped),
  );

  it.effect("does not treat its own launcher as another t3 when its folder is first on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const launcher = path.join(home, ".t3", "bin", "t3");
      process.env.PATH = searchPath(path, path.dirname(launcher), path.join(home, ".local", "bin"));

      const command = yield* commandIn({ home });
      const installed = yield* command.install;

      expect(yield* fs.exists(launcher)).toBe(true);
      expect(installed).toMatchObject({
        onPath: true,
        installedPath: path.join(home, ".local", "bin", "t3"),
      });
      expect(installed.shadowedBy).toBeUndefined();
      expect(yield* command.state).toEqual(installed);

      const removed = yield* command.uninstall;
      expect(removed.installedPath).toBeNull();
      expect(removed.onPath).toBe(true);
      expect(yield* command.state).toEqual(removed);
      expect(yield* fs.exists(installed.installedPath!)).toBe(false);
      expect(yield* fs.exists(launcher)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the Windows PATH alone when it cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const userPath = "C:\\Users\\Me\\npm;%USERPROFILE%\\tools";
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      registry.failReads = true;
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("left unchanged");
      expect(registry).toMatchObject({ path: userPath, writes: 0 });

      registry.failReads = false;
      const launcherDir = DesktopCliShim.launcherPath(
        environmentFor(yield* Path.Path, { home, baseDir: `${home}/.t3`, platform: "win32" }),
      ).replace(/[\\/]t3\.cmd$/, "");
      yield* command.install;
      expect(registry.path).toBe(`${userPath};${launcherDir}`);
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
    }).pipe(Effect.scoped),
  );

  it.effect("does not claim or remove a Windows PATH entry the user added", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const launcherDir = path.dirname(
        DesktopCliShim.launcherPath(
          environmentFor(path, { home, baseDir: path.join(home, ".t3"), platform: "win32" }),
        ),
      );
      const userPath = `C:\\Tools;${launcherDir}`;
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      expect((yield* command.state).installedPath).toBeNull();
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
    }).pipe(Effect.scoped),
  );

  it.effect("never edits the Windows PATH from a Factory preview", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const userPath = "C:\\Users\\Me\\npm";
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn(
        { home, platform: "win32", distribution: "factory-preview" },
        spawner,
      );

      expect((yield* command.state).supported).toBe(false);
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("does not install a t3 command");
      expect(registry).toMatchObject({ path: userPath, writes: 0 });
    }).pipe(Effect.scoped),
  );
});
