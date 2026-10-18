'use client';

import type { KeyboardEvent } from 'react';
import { Pause, Play } from 'lucide-react';
import { Icon } from '@/components/tool-editor/icon';
import { Kbd } from '@/components/tool-editor/kbd';
import { SPEEDS, clockTime } from './replay';
import type { Replay } from './use-replay';
import { formatCount } from './flow-format';

const BTN =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-[14px] leading-none text-[var(--text)] outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none! disabled:text-[var(--text-3)] disabled:hover:bg-transparent';

interface Props {
  replay: Replay;
  /** Events are still loading (or failed): the control is shown disabled. */
  loading: boolean;
  /** The window holds more events than were sent. */
  truncated?: boolean;
  /** Start of the window, shown before the first event. */
  from?: string;
}

/** `[Play] [scrubber] [1× 4× 16×] 14:05:09 · 12/240`, one 40px row. */
export function FlowTimeline({ replay, loading, truncated, from }: Props) {
  const { total, position, playing, active, speed, current } = replay;
  const disabled = loading || total === 0;
  const count = `${formatCount(total)}${truncated ? '+' : ''}`;
  const time = current ? clockTime(current.ts) : clockTime(from);
  const label = loading ? '—' : total === 0 ? '0 events' : active ? `${time} · ${position}/${total}` : `${count} events`;

  // Space anywhere in the control plays or pauses (the buttons would otherwise click).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || disabled) return;
    e.preventDefault();
    replay.toggle();
  };

  return (
    <div
      role="group"
      aria-label="Replay"
      data-testid="flow-timeline"
      data-playing={playing ? 'true' : undefined}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className="pointer-events-auto flex h-10 max-w-full shrink-0 items-center gap-1 rounded-md bg-[var(--surface)] px-1 leading-none shadow-[var(--shadow)]"
    >
      <button
        type="button"
        data-testid="flow-timeline-play"
        aria-label={playing ? 'Pause' : 'Play'}
        aria-keyshortcuts="Space"
        disabled={disabled}
        onClick={replay.toggle}
        className={BTN}
      >
        <Icon as={playing ? Pause : Play} />
      </button>
      <input
        type="range"
        data-testid="flow-timeline-scrubber"
        aria-label="Replay position"
        aria-valuetext={disabled ? label : `${time} · ${position}/${total}`}
        min={0}
        max={Math.max(total, 1)}
        step={1}
        value={disabled ? 0 : position}
        disabled={disabled}
        onChange={(e) => replay.seek(Number(e.target.value))}
        className="h-8 w-28 min-w-0 shrink cursor-pointer accent-[var(--text)] outline-none focus-visible:outline-none! disabled:cursor-default sm:w-44"
      />
      <div role="radiogroup" aria-label="Speed" className="flex items-center">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={speed === s}
            data-testid={`flow-timeline-speed-${s}`}
            disabled={disabled}
            onClick={() => replay.setSpeed(s)}
            className={`${BTN} font-mono tabular-nums ${speed === s ? 'bg-[var(--surface-2)] font-semibold' : 'text-[var(--text-3)]'}`}
          >
            {s}×
          </button>
        ))}
      </div>
      <span
        data-testid="flow-timeline-label"
        className={`min-w-0 truncate whitespace-nowrap px-1.5 font-mono text-[14px] tabular-nums ${
          disabled ? 'text-[var(--text-3)]' : 'text-[var(--text-2)]'
        }`}
      >
        {label}
      </span>
      {!disabled && (
        <Kbd className="hidden pr-1.5 text-[14px] lg:inline-flex">Space</Kbd>
      )}
    </div>
  );
}
