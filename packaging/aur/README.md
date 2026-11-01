# AUR packaging

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) packages. Both
repackage the official x86_64 AppImage from GitHub Releases.

## Publishing

Upstream's release workflow calls `.github/workflows/publish-aur.yml` after publishing a GitHub
release. In T3Factory, that caller is inactive and `publish-aur.yml` has no manual dispatch entry
point. These retained scripts target the upstream packages, not a Factory preview. See
[T3Factory release operations](../../docs/operations/release.md).

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```
