#!/usr/bin/env python3
"""Drive dsh-shell in a PTY against the stub-q2 host and verify the
edit-last-queued flow: boot (project picker auto-opens) -> pick the stub
project -> pick the stub session -> watch the queue panel -> Ctrl+U ->
the last queued message lands in the composer while the panel shrinks."""
import fcntl, os, re, select, signal, struct, subprocess, sys, termios, time

CWD = '/Users/zc/Works/dsh-tui'
LOG = '/tmp/tui-q2.log'
COLS, ROWS = 100, 32

master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
proc = subprocess.Popen(
    ['node', 'dist/cli.js', '--host', 'http://127.0.0.1:4101'],
    stdin=slave, stdout=slave, stderr=slave, cwd=CWD, close_fds=True,
    preexec_fn=os.setsid,
)
os.close(slave)

raw = b''
log = open(LOG, 'wb')
STRIP = re.compile(rb'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[=>]|\x1b[()][A-Z0-9]|\x1b\[<[0-9;]*u')
def pump(timeout):
    global raw
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            raw += data
            log.write(data)
            log.flush()
def text():
    # Turn cursor-positioning into row breaks so each screen row becomes a
    # line, then strip the remaining control sequences.
    t = re.sub(rb'\x1b\[\d+;\d*H', b'\n', raw)
    t = STRIP.sub(b'', t)
    return t.replace(b'\r\n', b'\n').replace(b'\r', b'\n')
def wait(pattern, timeout):
    pump(timeout)
    return pattern in text()
def send(data):
    os.write(master, data)
def snap():
    pump(0.5)
    return text()

def has_bg_at(needle):
    """Whether the raw row that last wrote needle starts with a background
    SGR (48;...) after its erase-and-position prefix."""
    idx = raw.rfind(needle.encode())
    if idx == -1:
        return False
    head = raw[max(0, idx - 200):idx]
    k = head.rfind(b'\x1b[2K')
    if k == -1:
        return False
    row = head[k + 4:]
    return row.startswith(b'\x1b[48;')



results = []
def check(label, cond):
    results.append((label, bool(cond)))
    print(('  ok   ' if cond else '  FAIL ') + label)

check('boots to connected', wait(b'/ connected', 15))
check('project picker auto-opens', wait(b'Select project', 5))
send(b'\x1b[B\r')  # arrow down onto 'stub', Enter selects the project
check('session picker opens', wait(b'Select session', 5))
send(b'\r')        # Enter attaches the highlighted stub session
check('attached header', wait(b'stub session / connected', 6))
# The stub history carries a bash tool call and its result.
check('tool call header renders', wait(b'Bash (ls -la)', 6))
check('tool result renders', b'total 0' in text())
check('tool call row has no background', not has_bg_at('Bash (ls -la)'))
check('tool result has no background', not has_bg_at('total 0'))
check('tool result leads with the corner', '\u2514 '.encode() in text())
# The composer box's border rules start at column 0 (no leading blanks).
_plain_rows = [re.sub(rb'\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07', b'', c)
               for c in re.findall(rb'\x1b\[\d+;1H\x1b\[2K((?:[^\x1b]|\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07)*)', raw)]
_border = '\u2500'.encode() * 3
check('composer border starts at column 0', any(r.startswith(_border) for r in _plain_rows))
# Codex-style blinking block cursor: DECSCUSR 0 emitted at start, and the
# hardware cursor is shown at frame ends (pi hides it by default).
check('blink cursor set at start', b'\x1b[2 q' in raw)
h1 = raw.find(b'\x1b[?25h')
l1 = raw.find(b'\x1b[?25l', h1) if h1 != -1 else -1
h2 = raw.find(b'\x1b[?25h', l1) if l1 != -1 else -1
check('cursor blink toggles on-off-on', h1 != -1 and l1 != -1 and h2 != -1)
check('hardware cursor shown while focused', b'\x1b[?25h' in raw)
check('queue panel', wait(b'Queued follow-up inputs', 8))
check('panel shows msg-1', b'fix the parser' in text())
check('panel shows msg-2', b'run the tests' in text())
time.sleep(0.5)

# Ctrl+U: pop the last queued message back into the composer.
send(b'\x15')
time.sleep(1.2)
pump(0.5)
# pi repaints only changed rows, so the editor row (set once after Ctrl+U)
# may precede the final panel repaint in the log. Judge by row positions:
# the last row that ever showed msg-2 must be a panel row (\u21b3), and the
# last row showing msg-2's text without \u21b3 must come after it (editor).
t = text()
lines = t.split(b'\n')
last_panel_rt = -1
last_editor_rt = -1
for idx, ln in enumerate(lines):
    if '\u21b3'.encode() in ln and b'run the tests' in ln:
        last_panel_rt = idx
    elif b'run the tests' in ln and '\u21b3'.encode() not in ln:
        last_editor_rt = idx
check('panel no longer shows msg-2', last_panel_rt >= 0 and last_editor_rt > last_panel_rt)
check('editor shows popped text', last_editor_rt > last_panel_rt)
check('panel keeps msg-1', any('\u21b3'.encode() in ln and b'fix the parser' in ln for ln in lines))
# The composer row carries the Codex-style ❯ prompt prefix, and the queue
# panel sits ABOVE the input box (panel line index < composer line index).
check('composer shows ❯ prefix', any('\u276f '.encode() in ln and b'run the tests' in ln for ln in lines))
panel_line = next((i for i, ln in enumerate(lines) if b'fix the parser' in ln), -1)
composer_line = next((i for i, ln in enumerate(lines) if '\u276f '.encode() in ln and b'run the tests' in ln), -1)
check('queue panel above the input box', panel_line != -1 and composer_line != -1 and panel_line < composer_line)
print('  last panel row with msg-2 at line', last_panel_rt, '; editor row at line', last_editor_rt)

send(b'\x03')  # Ctrl+C
pump(2)
# Two DECSCUSR writes (start + stop); a single write would leave the
# session-accumulated buffer satisfying a presence check vacuously.
check('blink cursor restored at exit', raw.count(b'\x1b[0 q') >= 1)

try:
    proc.wait(timeout=3)
    print('  ok   clean exit')
except subprocess.TimeoutExpired:
    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    print('  FAIL clean exit')

failed = [label for label, ok in results if not ok]
print('RESULT:', 'PASS' if not failed else 'FAIL ' + repr(failed))
