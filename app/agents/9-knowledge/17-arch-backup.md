---
title: Arch / CachyOS backup recipe
summary: The working recipe for a CachyOS/Arch machine backup that can actually be restored.
---

The working recipe for a CachyOS/Arch machine backup that can actually be restored.

## What to capture (in order)
1. `/etc` — full copy: `sudo rsync -aHAX /etc/ …` (preserves shadow/gshadow, sudoers,
   NetworkManager `psk=` secrets).
2. System info — hostname, `/etc/fstab`, enabled services/timers, mirrorlist, bootloader config
   (here: **Limine** + btrfs snapshots, not systemd-boot), btrfs subvolume/layout dump.
3. Home dotfiles — rsync with an exclude filter (Steam, `.cache`, Thunderbird, ollama, Rust, Discord,
   VS Code, Trash).
4. Secrets — GNOME keyring, KWallet, GPG private keys, SSH keys, Chromium-family
   `Login Data` + `Local State`, Firefox `key4.db`, NM profiles. Store encrypted, never plain.
5. Packages — map each installed package to its source repo using pacman.conf priority
   (`cachyos-v3 → cachyos-extra-v3 → cachyos-core-v3 → cachyos → core → extra → multilib`) via
   `expac` / `pacman -Sl` → `packages.tsv` + `restore-packages.sh`; plus flatpak/npm/cargo/pip lists.
6. A README that says what each part is and how to restore it.

## Verify
`/etc` file count must match the source (dirs are 700 → needs sudo); run `bash -n` on every script
before shipping it; a backup that was never restored is a hypothesis, not a backup.
