import { usePlayer } from '../usePlayer'
import { useShortcuts } from '../useShortcuts'
import { useEffect, useState } from 'react'
import Controls from '../components/Controls'
import ResizeGrips, { type Edge } from '../components/ResizeGrips'
import type { TimeFormat } from '../usePlayer'

// time → timecode → frame → time …
const NEXT_FORMAT: Record<TimeFormat, TimeFormat> = {
  time: 'timecode',
  timecode: 'frame',
  frame: 'time'
}

// Runs inside the Win11 acrylic window. The window itself provides the frosted
// background; the panel fills it and stays transparent so the acrylic shows.
export default function OscView() {
  const p = usePlayer()
  // the readout format is persisted, so it survives a restart
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('time')
  // docked = full-bleed bar at the window's bottom edge (main sizes/places the window;
  // this only picks the CSS variant). Whether it may auto-hide is the main process's
  // call — it simply stops sending ui:hide here while the bar is pinned.
  const [docked, setDocked] = useState(false)
  // window edges this bar covers and must hand back (main decides the set — it depends
  // on the style, fullscreen/maximized, and which side panel is open)
  const [grips, setGrips] = useState<Edge[]>([])
  useEffect(() => window.mmp.onOscGrips(e => setGrips(e as Edge[])), [])
  useEffect(() => {
    window.mmp.getSettings().then(s => {
      setTimeFormat(s.timeFormat)
      setDocked(s.oscStyle === 'docked')
    })
    return window.mmp.onSettingsChanged(s => {
      setTimeFormat(s.timeFormat)
      setDocked(s.oscStyle === 'docked')
    })
  }, [])
  const cycleTimeFormat = (): void => {
    const next = NEXT_FORMAT[timeFormat]
    setTimeFormat(next) // optimistic: don't wait for the round-trip
    window.mmp.setSetting('timeFormat', next)
  }

  useShortcuts({
    escape: () => window.mmp.exitFullscreen(),
    togglePause: p.togglePause,
    seekBy: p.seekBy,
    frameStep: p.frameStep,
    paused: p.state.pause,
    bumpVolume: d => p.setVolume(p.state.volume + d),
    toggleMute: p.toggleMute,
    fullscreen: p.fullscreen,
    openFile: p.openFile,
    next: () => window.mmp.playNext(),
    prev: () => window.mmp.playPrev(),
    onActivity: p.reveal
  })

  return (
    <div
      className={`osc-win ${docked ? 'docked' : ''} ${p.showUi ? 'ui-visible' : 'ui-hidden'}`}
      // Only keep the OSC alive on move while it's actually shown. When hidden
      // it still sits at the bottom and receives events, so revealing on move
      // here would pop it when the pointer merely passes over on its way into
      // the window — the main window's guarded reveal handles summoning instead.
      onMouseMove={() => {
        if (p.showUi) p.reveal()
      }}
      onMouseEnter={() => window.mmp.setOscHover(true)}
      onMouseLeave={() => window.mmp.setOscHover(false)}
    >
      <Controls
        docked={docked}
        timeFormat={timeFormat}
        onCycleTimeFormat={cycleTimeFormat}
        state={p.state}
        onTogglePause={p.togglePause}
        onSeek={p.seekTo}
        onSeekBy={p.seekBy}
        onSetVolume={p.setVolume}
        onToggleMute={p.toggleMute}
        onFullscreen={p.fullscreen}
      />
      {grips.length > 0 && <ResizeGrips edges={grips} />}
    </div>
  )
}
