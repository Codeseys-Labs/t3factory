// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { OwnedProcessSpawner } from "@t3tools/shared/ownedProcess";
import type { OwnedProcessGroup } from "./OwnedProcess.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const jobHost = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class T3OwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Port { public IntPtr Key, Handle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show,ReservedSize; public IntPtr Reserved2,In,Out,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  // JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO (4): the job drained, including descendants.
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,uint n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr f,IntPtr e,IntPtr k,uint n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr p,out uint n,out IntPtr k,out IntPtr o,uint ms);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup s,out ProcessInfo p);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint c);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static void Info<T>(IntPtr j,int c,T value) {
    int size=Marshal.SizeOf(typeof(T)); IntPtr mem=Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(value,mem,false); Check(SetInformationJobObject(j,c,mem,(uint)size)); }
    finally { Marshal.FreeHGlobal(mem); }
  }
  public static int Run(string line,NamedPipeClientStream control) {
    IntPtr job=IntPtr.Zero,port=IntPtr.Zero; ProcessInfo p=new ProcessInfo(); bool assigned=false;
    using(control) {
      var reader=new StreamReader(control,Encoding.UTF8);
      var writer=new StreamWriter(control,new UTF8Encoding(false)); writer.AutoFlush=true;
      try {
        job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
        var limits=new Extended(); limits.Basic.Flags=0x2000;
        Info(job,9,limits);
        port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,IntPtr.Zero,1); Check(port!=IntPtr.Zero);
        Info(job,7,new Port { Key=job,Handle=port });
        Check(SetHandleInformation(job,1,0));
        Check(SetHandleInformation(port,1,0));
        // Inherit the helper's std handles so wrapped consumers (codex app-server stdio)
        // keep their output; Asynchronous control-pipe I/O keeps the parked ReadLine from
        // serializing behind these writes.
        var s=new Startup(); s.Size=(uint)Marshal.SizeOf(typeof(Startup)); s.Flags=0x100;
        s.In=GetStdHandle(-10);s.Out=GetStdHandle(-11);s.Error=GetStdHandle(-12);
        Check(SetHandleInformation(s.In,1,1));Check(SetHandleInformation(s.Out,1,1));Check(SetHandleInformation(s.Error,1,1));
        Check(CreateProcess(null,new StringBuilder(line),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref s,out p));
        Check(AssignProcessToJobObject(job,p.Process)); assigned=true;
        lock(writer) { writer.WriteLine("contained"); }
        var first=reader.ReadLine();
        if(first!="resume") {
          Check(TerminateJobObject(job,125));
          // Emit the protocol lines before self-terminating: a sealed race otherwise
          // leaves rootExit/empty to the socket-close rejection path.
          lock(writer) { writer.WriteLine("root-exited:125"); writer.WriteLine("empty"); }
          TerminateProcess(GetCurrentProcess(),125);
          return 125;
        }
        Check(ResumeThread(p.Thread)!=0xffffffff);
        var stop=new Thread(()=> { try { reader.ReadLine(); } catch {} TerminateJobObject(job,1); });
        stop.IsBackground=true;stop.Start();
        var rootWait=new Thread(()=> { Check(WaitForSingleObject(p.Process,0xffffffff)==0); uint rootCode;Check(GetExitCodeProcess(p.Process,out rootCode)); lock(writer) { writer.WriteLine("root-exited:"+rootCode); } });
        rootWait.IsBackground=true;rootWait.Start();
        while(true) {
          uint message;IntPtr key,overlap;
          Check(GetQueuedCompletionStatus(port,out message,out key,out overlap,0xffffffff));
          if(message==4 && key==job) break;
        }
        rootWait.Join();
        uint code;Check(GetExitCodeProcess(p.Process,out code));
        lock(writer) { writer.WriteLine("empty"); }
        // Raw self-terminate: CLR/PowerShell shutdown deadlocks with the stop-thread parked in ReadLine.
        TerminateProcess(GetCurrentProcess(),code);
        return unchecked((int)code);
      } catch(Exception e) { try {writer.WriteLine("error:"+e.GetType().Name);} catch {} return 125; }
      finally {
        if(assigned) TerminateJobObject(job,1);
        else if(p.Process!=IntPtr.Zero) { TerminateProcess(p.Process,125);WaitForSingleObject(p.Process,0xffffffff); }
        if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);if(p.Process!=IntPtr.Zero)CloseHandle(p.Process);
        if(job!=IntPtr.Zero)CloseHandle(job);if(port!=IntPtr.Zero)CloseHandle(port);
      }
    }
  }
}`;

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

const platformError = (cause: unknown) =>
  PlatformError.systemError({
    module: "ChildProcess",
    method: "spawnOwned",
    _tag: "Unknown",
    cause,
  });

interface JobControl {
  readonly empty: Promise<void>;
  readonly rootExit: Promise<number>;
  readonly stop: () => void;
  exit?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
}
export const makeWindowsOwnedProcess = Effect.fn("WindowsOwnedProcess.make")(function* (options?: {
  readonly onObservation?: (event: string) => void;
}): Effect.fn.Return<OwnedProcessGroup> {
  const jobs = new Set<JobControl>();
  let sealed = false;
  let pending = 0;
  const spawner: OwnedProcessSpawner = {
    spawn: Effect.fn("WindowsOwnedProcess.spawn")(function* (command, native) {
      if (
        (yield* HostProcess.Platform) !== "win32" ||
        command._tag !== "StandardCommand" ||
        sealed
      ) {
        return yield* platformError("Owned process acquisition is unavailable or stopped.");
      }
      pending++;
      return yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const pipeName = `t3-owned-${NodeCrypto.randomUUID()}`;
          let socket: NodeNet.Socket | undefined;
          let observedEmpty = false;
          let containedSeen = false;
          let rootCode: number | undefined;
          let resolveRootExit!: (code: number) => void;
          let rejectRootExit!: (cause: unknown) => void;
          let resolveEmpty!: () => void;
          let rejectEmpty!: (cause: unknown) => void;
          let resolveContained!: () => void;
          let rejectContained!: (cause: unknown) => void;
          const rootExit = new Promise<number>((resolve, reject) => {
            resolveRootExit = resolve;
            rejectRootExit = reject;
          });
          void rootExit.catch(() => {});
          const empty = new Promise<void>((resolve, reject) => {
            resolveEmpty = resolve;
            rejectEmpty = reject;
          });
          const contained = new Promise<void>((resolve, reject) => {
            resolveContained = resolve;
            rejectContained = reject;
          });
          // Rejections are retained for the explicit join, even when acquisition fails first.
          void empty.catch(() => {});
          void contained.catch(() => {});
          const job: JobControl = {
            empty,
            rootExit,
            stop: () => {
              socket?.write("stop\n");
            },
          };
          jobs.add(job);
          const server = NodeNet.createServer((connection) => {
            if (socket !== undefined) {
              connection.destroy();
              return;
            }
            socket = connection;
            options?.onObservation?.("observer-connected");
            server.close();
            let buffer = "";
            connection.setEncoding("utf8");
            connection.on("data", (data: string) => {
              buffer += data;
              let end: number;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end).trim();
                buffer = buffer.slice(end + 1);
                options?.onObservation?.(line);
                if (line === "contained" && !containedSeen) {
                  containedSeen = true;
                  connection.write(sealed ? "stop\n" : "resume\n");
                  resolveContained();
                }
                if (line.startsWith("root-exited:")) {
                  rootCode = Number(line.slice("root-exited:".length));
                  resolveRootExit(rootCode);
                }
                if (line === "empty" && containedSeen) {
                  observedEmpty = true;
                  resolveEmpty();
                }
                if (line.startsWith("error:")) {
                  rejectContained(new Error(line));
                  rejectEmpty(new Error(line));
                  rejectRootExit(new Error(line));
                }
              }
            });
            connection.on("error", (cause) => {
              rejectContained(cause);
              rejectEmpty(cause);
              rejectRootExit(cause);
            });
            connection.on("close", () => {
              if (!observedEmpty) {
                rejectContained(new Error("Job observer disconnected"));
                rejectEmpty(new Error("Job observer disconnected"));
                rejectRootExit(new Error("Job observer disconnected"));
              }
            });
          });
          yield* Effect.tryPromise({
            try: () =>
              new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
              }),
            catch: (cause) => {
              rejectEmpty(cause);
              rejectRootExit(cause);
              return platformError(cause);
            },
          });
          let line = [command.command, ...command.args].map(quoteWindowsArgument).join(" ");
          if (command.options.shell)
            line = `cmd.exe /d /s /c "${command.command}${command.args.length === 0 ? "" : ` ${command.args.map(quoteWindowsArgument).join(" ")}`}"`;
          const script = `$ErrorActionPreference='Stop'
$control = [IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
$control.Connect()
$reporter = [IO.StreamWriter]::new($control, [Text.UTF8Encoding]::new($false))
$reporter.AutoFlush = $true
try {
$source = @'
${jobHost}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
$code = [T3OwnedJob]::Run([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(line).toString("base64")}')), $control)
exit $code
} catch {
$reporter.WriteLine('error:bootstrap:' + $_.Exception.Message.Replace([char]10, ' ').Replace([char]13, ' '))
$control.Dispose()
exit 125
}`;
          const wrapped = ChildProcess.make(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(script, "utf16le").toString("base64"),
            ],
            { ...command.options, shell: false },
          );
          const acquired = yield* Effect.exit(
            native.spawn(wrapped).pipe(Effect.provideService(Scope.Scope, scope)),
          );
          if (Exit.isFailure(acquired)) {
            if (server.listening) server.close();
            rejectEmpty(new Error("Job acquisition failed without observation"));
            rejectRootExit(new Error("Job acquisition failed"));
            yield* Scope.close(scope, acquired);
            return yield* Effect.failCause(acquired.cause);
          }
          const handle = acquired.value;
          job.exit = handle.exitCode;
          yield* handle.exitCode.pipe(
            Effect.tap((code) =>
              Effect.sync(() => {
                options?.onObservation?.(`helper-exit:${code}`);
                if (socket === undefined) {
                  rejectContained(new Error("Job host exited before empty observation"));
                  rejectEmpty(new Error("Job host exited before empty observation"));
                  rejectRootExit(new Error("Job host exited before root observation"));
                }
              }),
            ),
            Effect.forkIn(scope),
          );
          const close = Effect.tryPromise({
            try: () => {
              job.stop();
              return empty;
            },
            catch: platformError,
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                socket?.destroy();
                if (server.listening) server.close();
              }),
            ),
            Effect.ensuring(Scope.close(scope, Exit.void)),
          );
          yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
          yield* Effect.tryPromise({ try: () => contained, catch: platformError });
          // The handle is the root, as on Linux; the helper exits only once the whole job is empty.
          return {
            ...handle,
            exitCode: Effect.tryPromise({ try: () => rootExit, catch: platformError }).pipe(
              Effect.map(ChildProcessSpawner.ExitCode),
              Effect.catch(() => handle.exitCode),
            ),
            isRunning: Effect.suspend(() =>
              rootCode === undefined ? handle.isRunning : Effect.succeed(false),
            ),
            kill: () => Effect.sync(job.stop).pipe(Effect.andThen(handle.exitCode), Effect.asVoid),
          };
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending--;
          }),
        ),
      );
    }),
  };
  const quiesce = Effect.fn("WindowsOwnedProcess.quiesce")(function* () {
    sealed = true;
    for (const job of jobs) job.stop();
    if (pending !== 0) return false;
    const result = yield* Effect.tryPromise({
      try: () => Promise.all([...jobs].map((job) => job.empty)),
      catch: platformError,
    }).pipe(Effect.result);
    if (result._tag !== "Success") return false;
    for (const job of jobs) {
      if (job.exit === undefined) return false;
      const joined = yield* job.exit.pipe(Effect.result);
      if (joined._tag !== "Success") return false;
    }
    return true;
  });
  const awaitRootExits = Effect.tryPromise({
    try: () => Promise.all([...jobs].map((job) => job.rootExit)),
    catch: platformError,
  }).pipe(Effect.asVoid);
  return { spawner, quiesce, awaitRootExits };
});
