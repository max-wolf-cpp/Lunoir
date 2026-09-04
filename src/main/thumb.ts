// Seek-bar preview: a second, silent mpv with its OWN native window (not --wid
// into an Electron BrowserWindow). Chromium's compositor cannot stably present
// an external D3D frame in a small child window — that's why the first attempt
// flashed then went black. Screenshot-to-file followed the pointer in jumps.
// A real mpv HWND seeks in place, which is how MPC-HC does it.
import { app, screen, type Rectangle } from 'electron'
import koffi from 'koffi'
import { MpvController } from './mpv'
import { setHwndCloaked } from './dwm'

export const THUMB_W = 320
export const THUMB_H = 180
const TIME_H = 22
const WIN_H = THUMB_H + TIME_H
const FLOAT_GAP = 8
const DOCK_GAP = 12
const TITLE = 'LunoirThumb'
const MIN_SEEK_MS = 70

const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const HWND_TOPMOST = -1n
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020
const SWP_SHOWWINDOW = 0x0040

let FindWindowW: ((cls: bigint, name: string) => bigint) | null = null
let SetWindowPos:
  | ((
      hwnd: bigint,
      after: bigint,
      x: number,
      y: number,
      cx: number,
      cy: number,
      flags: number
    ) => number)
  | null = null
let GetWindowLongPtrW: ((hwnd: bigint, idx: number) => bigint) | null = null
let SetWindowLongPtrW: ((hwnd: bigint, idx: number, val: bigint) => bigint) | null = null

try {
  const user32 = koffi.load('user32.dll')
  FindWindowW = user32.func('uintptr_t FindWindowW(uintptr_t lpClassName, str16 lpWindowName)') as never
  SetWindowPos = user32.func(
    'int SetWindowPos(uintptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
  ) as never
  GetWindowLongPtrW = user32.func('intptr_t GetWindowLongPtrW(uintptr_t hWnd, int nIndex)') as never
  SetWindowLongPtrW = user32.func(
    'intptr_t SetWindowLongPtrW(uintptr_t hWnd, int nIndex, intptr_t dwNewLong)'
  ) as never
} catch (e) {
  console.error('[thumb] user32 unavailable:', e)
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

const THUMB_ARGS = [
  '--ao=null',
  '--volume=0',
  '--pause',
  '--force-window=immediate',
  '--border=no',
  '--title-bar=no',
  '--ontop',
  `--geometry=${THUMB_W}x${WIN_H}+0-4000`,
  '--keepaspect-window=no',
  '--keepaspect=yes',
  `--video-margin-ratio-bottom=${TIME_H / WIN_H}`,
  '--background=color',
  '--background-color=#FF3A3A3A',
  '--input-default-bindings=no',
  '--input-vo-keyboard=no',
  '--window-dragging=no',
  '--focus-on=never',
  `--title=${TITLE}`,
  '--sid=no',
  '--aid=no',
  '--sub-auto=no',
  '--osd-bar=no',
  '--osd-level=1',
  '--osd-scale-by-window=no',
  '--osd-font=Segoe UI Semibold',
  '--osd-font-size=18.5',
  '--osd-spacing=0.6',
  '--osd-bold=no',
  '--osd-color=#FFCDCDD3',
  '--osd-outline-size=0',
  '--osd-shadow-offset=0',
  '--osd-back-color=#00000000',
  '--osd-align-x=center',
  '--osd-align-y=bottom',
  '--osd-margin-y=4',
  '--cursor-autohide=always'
]

export class ThumbnailService {
  private mpv: MpvController | null = null
  private mpvPath = ''
  private hwnd: bigint | null = null
  private enabled = false
  private visible = false
  private loaded: string | null = null
  private fileReady = false
  private warming = false
  private hasFrame = false
  private docked = false
  private videoH = THUMB_H
  private lastX = 0
  private lastOsc: Rectangle | null = null
  private lastFs = false
  private lastSeekAt = 0
  private queuedT: number | null = null
  private followTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPath: string | null = null

  create(mpvPath: string): void {
    this.mpvPath = mpvPath
  }

  private spawn(): void {
    if (this.mpv || !this.mpvPath) return
    this.mpv = new MpvController(this.mpvPath, 'mpvpipe-thumb')
    this.mpv.on('connected', () => {
      if (!app.isPackaged) console.log('[thumb] preview mpv connected')
      this.grabHwnd()
      if (this.pendingPath) this.applyFile(this.pendingPath)
    })
    this.mpv.on('mpv-event', (ev: string) => {
      if (ev === 'file-loaded') {
        this.fileReady = true
        this.hasFrame = false
        if (!app.isPackaged) console.log('[thumb] file-loaded')
        void this.fitAspect()
        if (this.visible && this.queuedT != null) this.flushSeek()
      }
      if (ev === 'video-reconfig') void this.fitAspect()
      if (ev === 'playback-restart' && this.warming) {
        this.warming = false
        this.hasFrame = true
        this.mpv?.setProperty('pause', true)
        if (this.visible && this.queuedT != null) this.flushSeek()
        else if (!this.visible) this.hide()
      }
    })
    this.mpv.on('log', (line: string) => {
      if (!app.isPackaged) process.stdout.write(`[thumb-mpv] ${line}`)
    })
    this.mpv.on('error', (err: Error) => console.error('[thumb]', err.message))
    this.mpv.on('exit', (code: number) => {
      if (code) console.error('[thumb] preview mpv exited', code)
    })
    this.mpv.start({ observe: false, extraArgs: THUMB_ARGS })
  }

  private grabHwnd(attempt = 0): void {
    if (!FindWindowW) return
    const hwnd = FindWindowW(0n, TITLE)
    if (hwnd && hwnd !== 0n) {
      this.hwnd = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd as number)
      this.styleWindow()
      if (this.hwnd) setHwndCloaked(this.hwnd, true)
      if (!app.isPackaged) console.log('[thumb] hwnd', String(this.hwnd))
      return
    }
    if (attempt < 40) setTimeout(() => this.grabHwnd(attempt + 1), 50)
    else console.error('[thumb] preview window HWND not found')
  }

  private styleWindow(): void {
    if (!this.hwnd || !GetWindowLongPtrW || !SetWindowLongPtrW || !SetWindowPos) return
    try {
      const ex = GetWindowLongPtrW(this.hwnd, GWL_EXSTYLE)
      SetWindowLongPtrW(this.hwnd, GWL_EXSTYLE, BigInt(ex) | BigInt(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE))
      SetWindowPos(this.hwnd, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE)
    } catch (e) {
      console.error('[thumb] styleWindow failed:', e)
    }
  }

  syncFile(path: string | null): void {
    if (!path) {
      this.enabled = false
      this.loaded = null
      this.fileReady = false
      this.hide()
      this.mpv?.command(['stop']).catch(() => {})
      return
    }
    this.enabled = true
    this.spawn()
    if (this.loaded === path) return
    this.loaded = path
    this.applyFile(path)
  }

  private applyFile(path: string): void {
    if (!this.mpv?.isConnected) {
      this.pendingPath = path
      return
    }
    this.pendingPath = null
    this.fileReady = false
    this.warming = false
    this.hasFrame = false
    if (!app.isPackaged) console.log('[thumb] loadfile', path)
    this.mpv.loadFile(path)
    this.mpv.setProperty('sid', 'no')
    this.mpv.setProperty('aid', 'no')
  }

  private winH(): number {
    return this.videoH + TIME_H
  }

  private async fitAspect(): Promise<void> {
    if (!this.mpv) return
    let ar = 16 / 9
    try {
      const v = await this.mpv.command(['get_property', 'video-params/aspect'])
      if (typeof v === 'number' && v > 0.2 && v < 6) ar = v
    } catch {
      return
    }
    const h = Math.max(90, Math.min(240, Math.round(THUMB_W / ar)))
    if (h === this.videoH) return
    this.videoH = h
    this.mpv.setProperty('video-margin-ratio-bottom', TIME_H / this.winH())
    if (this.visible && this.lastOsc) this.place(this.lastX, this.lastOsc, this.lastFs)
  }

  seek(t: number, xClient: number, osc: Rectangle, fullscreen: boolean, docked: boolean): void {
    if (!this.enabled || !this.mpv?.isConnected) return
    this.docked = docked
    this.show()
    this.place(xClient, osc, fullscreen)
    this.queuedT = t
    const now = Date.now()
    const wait = MIN_SEEK_MS - (now - this.lastSeekAt)
    if (wait <= 0) this.flushSeek()
    else if (!this.followTimer) {
      this.followTimer = setTimeout(() => this.flushSeek(), wait)
    }
  }

  private flushSeek(): void {
    if (this.followTimer) {
      clearTimeout(this.followTimer)
      this.followTimer = null
    }
    if (this.queuedT == null || !this.mpv) return
    if (!this.fileReady) return
    const t = this.queuedT
    this.lastSeekAt = Date.now()
    if (!this.hasFrame) {
      // First presentation must happen on an uncloaked, on-screen window.
      // Cloaked warmup left the swap chain black for good.
      this.warming = true
      this.mpv.command(['seek', t, 'absolute+exact']).catch(() => {})
      this.mpv.setProperty('pause', false)
      return
    }
    this.queuedT = null
    this.mpv.setProperty('pause', true)
    this.mpv.command(['seek', t, 'absolute+exact']).catch(() => {})
    this.mpv.command(['show-text', fmtTime(t), 100000]).catch(() => {})
  }

  hide(): void {
    this.visible = false
    if (this.followTimer) {
      clearTimeout(this.followTimer)
      this.followTimer = null
    }
    this.queuedT = null
    if (this.hwnd) {
      setHwndCloaked(this.hwnd, true)
      this.park()
    }
  }

  destroy(): void {
    this.hide()
    this.mpv?.quit()
    this.mpv = null
    this.hwnd = null
    this.loaded = null
    this.enabled = false
  }

  private show(): void {
    this.visible = true
    if (!this.hwnd) return
    setHwndCloaked(this.hwnd, false)
    // Nudge size so gpu-next rebuilds the swap chain after uncloak.
    if (SetWindowPos) {
      try {
        SetWindowPos(this.hwnd, HWND_TOPMOST, 0, 0, THUMB_W, this.winH() + 1, SWP_NOMOVE | SWP_NOACTIVATE)
        SetWindowPos(this.hwnd, HWND_TOPMOST, 0, 0, THUMB_W, this.winH(), SWP_NOMOVE | SWP_NOACTIVATE)
      } catch {}
    }
  }

  /** Off-screen fallback if cloak is ignored (window stays composed). */
  private park(): void {
    if (!this.hwnd || !SetWindowPos) return
    try {
      SetWindowPos(this.hwnd, HWND_TOPMOST, -3200, -3200, THUMB_W, this.winH(), SWP_NOACTIVATE)
    } catch {}
  }

  private place(xClient: number, osc: Rectangle, fullscreen: boolean): void {
    if (!this.hwnd || !SetWindowPos) return
    const disp = screen.getDisplayMatching(osc)
    const area = fullscreen ? disp.bounds : disp.workArea
    const scale = disp.scaleFactor || 1
    const wDip = THUMB_W / scale
    const hDip = this.winH() / scale
    const gap = this.docked ? DOCK_GAP : FLOAT_GAP
    this.lastX = xClient
    this.lastOsc = osc
    this.lastFs = fullscreen
    let x = osc.x + xClient - wDip / 2
    let y = osc.y - hDip - gap
    x = Math.max(area.x, Math.min(x, area.x + area.width - wDip))
    y = Math.max(area.y, Math.min(y, area.y + area.height - hDip))
    const phys = screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) })
    try {
      SetWindowPos(
        this.hwnd,
        HWND_TOPMOST,
        phys.x,
        phys.y,
        THUMB_W,
        this.winH(),
        SWP_NOACTIVATE | SWP_SHOWWINDOW
      )
    } catch (e) {
      console.error('[thumb] SetWindowPos failed:', e)
    }
  }
}
