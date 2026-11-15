#!/usr/bin/env python3
"""Pseudo-terminal for Agent Code's built-in terminal view (Python: Node has no pseudo-terminal of its own).

Usage: ptybridge.py COLS ROWS -- COMMAND [ARGS...]
stdin goes to the program's terminal, its output to stdout; fd 3 (optional) takes "resize COLS ROWS" lines.
Exits with the program's exit code; closing stdin hangs the program up.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EINTR):
                select.select([], [fd], [], 1)
                continue
            raise
        data = data[n:]


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    command = sys.argv[sys.argv.index("--") + 1:]
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(command[0], command)
        except OSError as error:
            sys.stderr.write(f"{command[0]}: {error}\n")
            os._exit(127)

    def resize(c, r):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", max(1, r), max(1, c), 0, 0))

    resize(cols, rows)
    inputs = [0, master]
    try:
        os.fstat(3)
        inputs.append(3)
    except OSError:
        pass
    control = b""
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                # Agent Code went away: hang the program up like a closed terminal window.
                os.kill(pid, signal.SIGHUP)
                inputs.remove(0)
            else:
                write_all(master, data)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
                continue
            control += data
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                parts = line.decode(errors="ignore").split()
                if len(parts) == 3 and parts[0] == "resize":
                    resize(int(parts[1]), int(parts[2]))
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


if __name__ == "__main__":
    main()
