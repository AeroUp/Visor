'use strict';
// Minimal Win32 bindings used to glue the overlay to the Roblox client window.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

koffi.struct('FL_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
koffi.struct('FL_POINT', { x: 'int32', y: 'int32' });
koffi.pointer('FL_HWND', koffi.opaque());

const FindWindowW = user32.func('FL_HWND __stdcall FindWindowW(const char16_t *cls, const char16_t *name)');
const IsWindow = user32.func('bool __stdcall IsWindow(FL_HWND h)');
const IsIconic = user32.func('bool __stdcall IsIconic(FL_HWND h)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(FL_HWND h)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(FL_HWND h, _Out_ FL_RECT *r)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(FL_HWND h, _Inout_ FL_POINT *p)');
const GetForegroundWindow = user32.func('FL_HWND __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(FL_HWND h)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(FL_HWND h, _Out_ uint32 *pid)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(FL_HWND h, _Out_ char16_t *buf, int max)');
const FindWindowExW = user32.func('FL_HWND __stdcall FindWindowExW(FL_HWND parent, FL_HWND after, const char16_t *cls, const char16_t *name)');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
const GetProcessTimes = kernel32.func('bool __stdcall GetProcessTimes(intptr_t h, _Out_ uint64 *created, _Out_ uint64 *exited, _Out_ uint64 *kernel, _Out_ uint64 *user)');
const CreateMutexW = kernel32.func('intptr_t __stdcall CreateMutexW(void *attrs, bool owner, const char16_t *name)');
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const FILETIME_UNIX_OFFSET_MS = 11644473600000;

// Address-based variants so we can also target our own Electron windows (we only have their HWND as a number).
const SetForegroundWindowN = user32.func('bool __stdcall SetForegroundWindow(intptr_t h)');
const BringWindowToTopN = user32.func('bool __stdcall BringWindowToTop(intptr_t h)');
const ShowWindowN = user32.func('bool __stdcall ShowWindow(intptr_t h, int cmd)');
const IsIconicN = user32.func('bool __stdcall IsIconic(intptr_t h)');
const GetWindowThreadProcessIdN = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t h, void *pid)');
const GetForegroundWindowN = user32.func('intptr_t __stdcall GetForegroundWindow()');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 from, uint32 to, bool attach)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
const SW_RESTORE = 9;
const DwmSetWindowAttribute = dwmapi.func('int32 __stdcall DwmSetWindowAttribute(intptr_t h, uint32 attr, void *value, uint32 size)');
const DWMWA_TRANSITIONS_FORCEDISABLED = 3;

const ROBLOX_CLASS = 'WINDOWSCLIENT';

const addr = (h) => (h ? koffi.address(h) : 0n);

function className(h) {
  if (!h) return '';
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(h, buf, 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function processId(h) {
  if (!h) return 0;
  const out = [0];
  GetWindowThreadProcessId(h, out);
  return out[0];
}

/** Returns the Roblox player window, preferring the foreground one when several clients are open. */
function findRoblox() {
  const fg = GetForegroundWindow();
  if (fg && className(fg) === ROBLOX_CLASS) return fg;
  const h = FindWindowW(ROBLOX_CLASS, null);
  return h && IsWindowVisible(h) ? h : null;
}

/** Every visible Roblox player window, with its process id. */
function robloxWindows() {
  const out = [];
  let h = null;
  for (let i = 0; i < 16; i++) {
    h = FindWindowExW(null, h, ROBLOX_CLASS, null);
    if (!h) break;
    if (IsWindowVisible(h)) out.push({ hwnd: h, address: addr(h), pid: processId(h) });
  }
  return out;
}

const createdCache = new Map();

/** When a process started (ms since epoch); used to match a Roblox window to its log file. */
function processCreatedAt(pid) {
  if (createdCache.has(pid)) return createdCache.get(pid);
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return null;
  try {
    const created = [0];
    if (!GetProcessTimes(h, created, [0], [0], [0])) return null;
    const ms = Number(BigInt(created[0]) / 10000n) - FILETIME_UNIX_OFFSET_MS;
    createdCache.set(pid, ms);
    if (createdCache.size > 64) createdCache.delete(createdCache.keys().next().value);
    return ms;
  } finally {
    CloseHandle(h);
  }
}

// Roblox only allows one client at a time by creating a "ROBLOX_singletonEvent". If a mutex with
// that name already exists, it can't, and every launch opens its own window instead.
let singleton = 0;

/** Returns true while multi-instance is in effect; false means a Roblox client is still holding the name. */
function holdRobloxSingleton(on) {
  if (!on) {
    if (singleton) CloseHandle(singleton);
    singleton = 0;
    return false;
  }
  if (singleton) return true;
  const h = CreateMutexW(null, true, 'ROBLOX_singletonEvent');
  if (!h) return false;
  singleton = h;
  return true;
}

/** Client-area rectangle of a window in physical screen pixels. */
function clientRect(h) {
  const r = {};
  if (!GetClientRect(h, r)) return null;
  const p = { x: 0, y: 0 };
  if (!ClientToScreen(h, p)) return null;
  return { x: p.x, y: p.y, width: r.right - r.left, height: r.bottom - r.top };
}

/**
 * SetForegroundWindow that also works when we are a background process (tray click,
 * `--toggle` from a macro tool): briefly attach to the current foreground thread's input.
 */
function forceForeground(address) {
  const h = typeof address === 'bigint' ? address : addr(address);
  if (!h) return false;
  if (IsIconicN(h)) ShowWindowN(h, SW_RESTORE);
  if (SetForegroundWindowN(h)) return true;
  const fgThread = GetWindowThreadProcessIdN(GetForegroundWindowN(), null);
  const me = GetCurrentThreadId();
  const attached = fgThread && fgThread !== me && AttachThreadInput(me, fgThread, true);
  BringWindowToTopN(h);
  const ok = SetForegroundWindowN(h);
  if (attached) AttachThreadInput(me, fgThread, false);
  return ok;
}

/** Turns off Windows' fade/zoom animation when a window is shown or hidden. */
function disableTransitions(address) {
  const on = Buffer.alloc(4);
  on.writeInt32LE(1);
  return DwmSetWindowAttribute(address, DWMWA_TRANSITIONS_FORCEDISABLED, on, 4) === 0;
}

module.exports = {
  robloxWindows,
  processCreatedAt,
  holdRobloxSingleton,
  forceForeground,
  disableTransitions,
  addr,
  findRoblox,
  clientRect,
  processId,
  isWindow: (h) => !!h && IsWindow(h),
  isMinimized: (h) => !!h && IsIconic(h),
  foreground: () => GetForegroundWindow(),
  setForeground: (h) => !!h && SetForegroundWindow(h),
};
