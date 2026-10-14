/**
 * Usage forecast chart.
 *
 * X is time, Y is percent of the window remaining, so each credential drains
 * from 100% at window start toward 0%. Each is a smooth area curve through its
 * recorded checkpoints (dots), ending at the current reading. A dashed line
 * continues at the recent pace to either the predicted runout at 0% (red
 * marker, labelled) or the projected level at reset.
 *
 * Checkpoints are recorded here whenever a fresh quota reading arrives, since
 * providers report no history (see usageHistory.ts).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { formatRelativeInstant } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { useNow } from '@/hooks/useNow';
import { IconChevronDown } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import {
  buildTimelineLane,
  HOUR_MS,
  type TimelineLane,
  type TimelineMode,
} from '../quotaTimelineModel';
import { forecastLane, sortForecasts, type UsageForecast } from '../usageForecastModel';
import {
  appendCheckpoint,
  historyKey,
  readUsageHistory,
  recentRate,
  writeUsageHistory,
  type UsageCheckpoint,
  type UsageHistory,
} from '../usageHistory';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import styles from './QuotaUsageForecast.module.scss';

/** Per-credential series colors; several credentials often share a provider. */
const SERIES_COLORS: Record<ResolvedTheme, string[]> = {
  dark: ['#f2f2f2', '#e2774f', '#4f9fd6', '#5fd1a4', '#d98ad0', '#e8d26a', '#9c8cff', '#ff8f8f'],
  light: ['#2b2b2b', '#c4572c', '#2a73b8', '#13895f', '#a8329c', '#9a7f00', '#5b45c9', '#c93636'],
};

const CHART_HEIGHT = 220;
const COLLAPSED_KEY = 'cpamc.quotaForecastCollapsed';
const PAD = { top: 26, right: 24, bottom: 30, left: 44 };
const Y_TICKS = [0, 25, 50, 75, 100];
const MODE_PERIODS: Record<TimelineMode, number> = { weekly: 14 * 24, session: 5 };

const pad = (value: number) => String(value).padStart(2, '0');
const formatInstant = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const formatTick = (ms: number, short: boolean) => {
  const d = new Date(ms);
  if (short) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
};

/** Monotone cubic path (no overshoot), the curve d3 calls monotoneX. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  const n = points.length;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1].x - points[i].x;
    slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx);
  }
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === n - 1) return slopes[n - 2];
    const a = slopes[i - 1];
    const b = slopes[i];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const h = (p1.x - p0.x) / 3;
    d += `C${p0.x + h},${p0.y + tangents[i] * h} ${p1.x - h},${p1.y - tangents[i + 1] * h} ${p1.x},${p1.y}`;
  }
  return d;
}

interface Series {
  forecast: UsageForecast;
  /** Curve points from the visible start through the current reading. */
  points: UsageCheckpoint[];
  /** Real recorded checkpoints, drawn as dots. */
  checkpoints: UsageCheckpoint[];
}

export interface QuotaUsageForecastProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (name: string) => string;
  resolvedTheme: ResolvedTheme;
  historySessionId: string;
  fileGenerations: Record<string, number>;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
}

export function QuotaUsageForecast({
  entries,
  quotaFor,
  displayNameFor,
  resolvedTheme,
  historySessionId,
  fileGenerations,
  now: nowProp,
}: QuotaUsageForecastProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<TimelineMode>('weekly');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((value) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, value ? '0' : '1');
      } catch {
        // Not persisted; the toggle still works for this visit.
      }
      return !value;
    });
  const [hovered, setHovered] = useState<string | null>(null);
  const [history, setHistory] = useState<UsageHistory>(() => readUsageHistory(historySessionId));
  const tick = useNow(nowProp === undefined);
  const now = nowProp ?? tick;

  const laneFor = (entry: QuotaFileEntry, maxPeriodHours: number): TimelineLane =>
    buildTimelineLane({
      name: getQuotaCacheKey(entry.file),
      displayName: displayNameFor(getQuotaDisplayName(entry.file)),
      provider: entry.type,
      quota: quotaFor(entry),
      maxPeriodHours,
    });

  /* ---------- Record checkpoints for each fresh reading ---------- */

  // Each fetch stores a new quota object, so identity marks a fresh reading.
  const seenRef = useRef(new WeakSet<object>());
  useEffect(() => {
    let next: UsageHistory | null = null;
    const at = Date.now();
    entries.forEach((entry) => {
      const quota = quotaFor(entry);
      if (!quota || quota.status !== 'success' || seenRef.current.has(quota)) return;
      seenRef.current.add(quota);
      Object.values(MODE_PERIODS).forEach((maxPeriod) => {
        const lane = laneFor(entry, maxPeriod);
        if (lane.anchorMs === null || !lane.periodHours || lane.remaining === null) return;
        const key = historyKey(
          entry.type,
          lane.name,
          lane.periodHours,
          fileGenerations[entry.file.name] ?? 0
        );
        next ??= { ...history };
        next[key] = appendCheckpoint(
          next[key] ?? [],
          { t: at, used: 100 - lane.remaining },
          lane.periodHours * HOUR_MS
        );
      });
    });
    if (next) {
      writeUsageHistory(historySessionId, next);
      setHistory(next);
    }
    // laneFor is derived from quotaFor/displayNameFor, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, quotaFor, displayNameFor, historySessionId, fileGenerations]);

  /* ---------- Series ---------- */

  const series = useMemo(() => {
    const out: Series[] = [];
    entries.forEach((entry) => {
      const lane = laneFor(entry, MODE_PERIODS[mode]);
      if (mode === 'session' && lane.periodHours !== 5) return;
      if (lane.anchorMs === null || !lane.periodHours) return;
      const periodMs = lane.periodHours * HOUR_MS;
      const windowStartMs = lane.anchorMs - periodMs;
      const recorded =
        history[
          historyKey(entry.type, lane.name, lane.periodHours, fileGenerations[entry.file.name] ?? 0)
        ] ?? [];
      const forecast = forecastLane(lane, now, recentRate(recorded, windowStartMs, periodMs));
      if (!forecast) return;

      // Previous window (if recorded), the reset to 0%, this window, then now.
      const shown = recorded.filter((p) => p.t >= windowStartMs - periodMs && p.t < now);
      const before = shown.filter((p) => p.t < windowStartMs);
      const during = shown.filter((p) => p.t >= windowStartMs);
      const points = [...before, { t: windowStartMs, used: 0 }, ...during];
      if (points[points.length - 1].t < now) points.push({ t: now, used: forecast.usedPercent });
      out.push({ forecast, points, checkpoints: shown });
    });
    const order = sortForecasts(out.map((s) => s.forecast));
    return order.map((f) => out.find((s) => s.forecast === f) as Series);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, quotaFor, displayNameFor, mode, now, history, fileGenerations]);

  /* ---------- Layout ---------- */

  // Text must not stretch with the SVG, so draw in real pixels.
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const hasData = series.length > 0;
  useEffect(() => {
    const node = chartRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasData, collapsed]);

  const domain = useMemo(() => {
    if (!hasData) return { from: now - HOUR_MS, to: now };
    return {
      from: Math.min(...series.map((s) => s.points[0].t)),
      // A little headroom so end markers aren't clipped at the right edge.
      to: (() => {
        const from = Math.min(...series.map((s) => s.points[0].t));
        const end = Math.max(...series.map((s) => s.forecast.runoutAtMs ?? s.forecast.resetAtMs));
        return end + (end - from) * 0.03;
      })(),
    };
  }, [series, hasData, now]);

  const atRisk = series.filter((s) => s.forecast.runoutAtMs !== null).length;
  const palette = SERIES_COLORS[resolvedTheme] ?? SERIES_COLORS.dark;

  if (!hasData && mode === 'weekly') return null;

  const plotW = Math.max(100, width - PAD.left - PAD.right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const x = (ms: number) => PAD.left + ((ms - domain.from) / (domain.to - domain.from)) * plotW;
  // Inputs stay in percent used; plotted as remaining (full at the top).
  const y = (usedPercent: number) => PAD.top + (usedPercent / 100) * plotH;
  const xTickCount = Math.max(2, Math.min(7, Math.floor(plotW / 130)));
  const xTicks = Array.from(
    { length: xTickCount + 1 },
    (_, i) => domain.from + ((domain.to - domain.from) * i) / xTickCount
  );

  // Runout labels: stack ones that would overlap horizontally.
  const runoutLabels: { name: string; x: number; row: number; text: string; color: string }[] = [];
  series.forEach((s, index) => {
    const runout = s.forecast.runoutAtMs;
    if (runout === null) return;
    const lx = x(runout);
    let row = 0;
    while (runoutLabels.some((l) => l.row === row && Math.abs(l.x - lx) < 120)) row += 1;
    runoutLabels.push({
      name: s.forecast.name,
      x: lx,
      row,
      text: formatInstant(runout),
      color: palette[index % palette.length],
    });
  });

  return (
    <section className={styles.forecast} data-reveal>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>
            <button
              type="button"
              className={styles.collapseToggle}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
            >
              <IconChevronDown size={16} className={styles.chevron} aria-hidden="true" />
              {t('quota_management.forecast_title', { defaultValue: 'Usage forecast' })}
            </button>
          </h2>
          <p className={styles.subtitle}>
            {atRisk > 0
              ? t('quota_management.forecast_at_risk', {
                  count: atRisk,
                  defaultValue: '{{count}} credential(s) on pace to run out before reset',
                })
              : t('quota_management.forecast_all_ok', {
                  defaultValue: 'Every credential is on pace to last until its reset',
                })}
          </p>
        </div>
        {!collapsed && (
          <div className={styles.modes} role="group">
            {(['weekly', 'session'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value === 'weekly'
                  ? t('quota_management.windows_mode_weekly', { defaultValue: 'Weekly' })
                  : t('quota_management.windows_mode_session', { defaultValue: '5-hour' })}
              </button>
            ))}
          </div>
        )}
      </header>

      {!collapsed && (
        <div className={styles.card}>
          <div className={styles.chart} ref={chartRef}>
            {!hasData ? (
              <div className={styles.empty} role="status">
                {t('quota_management.windows_empty_session', {
                  defaultValue: 'No credentials on this page report a 5-hour quota window.',
                })}
              </div>
            ) : (
              <svg width={width} height={CHART_HEIGHT} role="img" aria-label="Usage forecast">
                <defs>
                  {series.map((s, index) => (
                    <linearGradient
                      key={s.forecast.name}
                      id={`forecast-fill-${index}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor={palette[index % palette.length]}
                        stopOpacity={0.28}
                      />
                      <stop
                        offset="100%"
                        stopColor={palette[index % palette.length]}
                        stopOpacity={0.04}
                      />
                    </linearGradient>
                  ))}
                </defs>

                {Y_TICKS.map((value) => (
                  <g key={value}>
                    <line
                      className={value === 100 ? styles.limitLine : styles.gridLine}
                      x1={PAD.left}
                      x2={PAD.left + plotW}
                      y1={y(value)}
                      y2={y(value)}
                    />
                    <text
                      className={styles.axisText}
                      x={PAD.left - 8}
                      y={y(value)}
                      dy="0.32em"
                      textAnchor="end"
                    >
                      {100 - value}%
                    </text>
                  </g>
                ))}
                {xTicks.map((ms, i) => (
                  <text
                    key={ms}
                    className={styles.axisText}
                    x={x(ms)}
                    y={CHART_HEIGHT - 8}
                    textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
                  >
                    {formatTick(ms, mode === 'session')}
                  </text>
                ))}

                <line className={styles.nowLine} x1={x(now)} x2={x(now)} y1={PAD.top} y2={baseY} />
                <text className={styles.nowText} x={x(now)} y={PAD.top - 10} textAnchor="middle">
                  {t('quota_management.windows_now', { defaultValue: 'Now' })}
                </text>

                {series.map((s, index) => {
                  const { forecast } = s;
                  const color = palette[index % palette.length];
                  const px = s.points.map((p) => ({ x: x(p.t), y: y(p.used) }));
                  const line = smoothPath(px);
                  const area = `${line}L${px[px.length - 1].x},${baseY}L${px[0].x},${baseY}Z`;
                  const endMs = forecast.runoutAtMs ?? forecast.resetAtMs;
                  const endPct = forecast.runoutAtMs !== null ? 100 : forecast.projectedPercent;
                  const dimmed = hovered !== null && hovered !== forecast.name;
                  return (
                    <g
                      key={forecast.name}
                      className={styles.series}
                      data-dimmed={dimmed ? 1 : 0}
                      data-active={hovered === forecast.name ? 1 : 0}
                      style={{ '--series': color } as CSSProperties}
                      onMouseEnter={() => setHovered(forecast.name)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <path d={area} fill={`url(#forecast-fill-${index})`} />
                      <path className={styles.curve} d={line} />
                      <line
                        className={styles.projection}
                        x1={x(now)}
                        y1={y(forecast.usedPercent)}
                        x2={x(endMs)}
                        y2={y(endPct)}
                      />
                      {s.checkpoints.map((p) => (
                        <circle
                          key={p.t}
                          className={styles.checkpoint}
                          cx={x(p.t)}
                          cy={y(p.used)}
                          r={2.5}
                        >
                          <title>{`${forecast.displayName}\n${formatInstant(p.t)} · ${Math.round(p.used)}%`}</title>
                        </circle>
                      ))}
                      <circle
                        className={styles.nowDot}
                        cx={x(now)}
                        cy={y(forecast.usedPercent)}
                        r={5}
                      >
                        <title>{`${forecast.displayName}\n${Math.round(forecast.usedPercent)}% used now`}</title>
                      </circle>
                      <circle
                        className={forecast.runoutAtMs !== null ? styles.runoutDot : styles.endDot}
                        cx={x(endMs)}
                        cy={y(endPct)}
                        r={5}
                      >
                        <title>
                          {forecast.runoutAtMs !== null
                            ? `${forecast.displayName}\nRuns out ${formatInstant(forecast.runoutAtMs)}`
                            : `${forecast.displayName}\n${Math.round(forecast.projectedPercent)}% at reset ${formatInstant(forecast.resetAtMs)}`}
                        </title>
                      </circle>
                    </g>
                  );
                })}

                {runoutLabels.map((label) => {
                  // Tags sit in the empty top area; a guide drops to the 0% marker.
                  const tagX = Math.min(Math.max(label.x, PAD.left + 50), PAD.left + plotW - 50);
                  const tagY = y(0) + 12 + label.row * 22;
                  return (
                    <g
                      key={label.name}
                      className={styles.runoutLabel}
                      data-dimmed={hovered !== null && hovered !== label.name ? 1 : 0}
                    >
                      <line
                        className={styles.runoutGuide}
                        x1={label.x}
                        x2={label.x}
                        y1={tagY + 9}
                        y2={y(100) - 6}
                      />
                      <g transform={`translate(${tagX}, ${tagY})`}>
                        <rect x={-50} y={-9} width={100} height={18} rx={9} />
                        <circle cx={-39} cy={0} r={3.5} fill={label.color} />
                        <text x={5} dy="0.34em" textAnchor="middle">
                          {label.text}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          {hasData && (
            <ul className={styles.legend}>
              {series.map(({ forecast }, index) => {
                const risk = forecast.runoutAtMs !== null;
                const target = forecast.runoutAtMs ?? forecast.resetAtMs;
                return (
                  <li
                    key={forecast.name}
                    data-risk={risk ? 1 : 0}
                    data-dimmed={hovered !== null && hovered !== forecast.name ? 1 : 0}
                    style={{ '--series': palette[index % palette.length] } as CSSProperties}
                    onMouseEnter={() => setHovered(forecast.name)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span className={styles.swatch} />
                    <span className={styles.name} title={forecast.displayName}>
                      {forecast.displayName}
                    </span>
                    <span className={styles.pct}>
                      {t('quota_management.forecast_left', {
                        defaultValue: '{{now}}% left → {{end}}%',
                        now: Math.round(100 - forecast.usedPercent),
                        end: Math.round(100 - forecast.projectedPercent),
                      })}
                    </span>
                    <span className={styles.eta}>
                      <span className={styles.etaKind}>
                        {risk
                          ? t('quota_management.forecast_runs_out', { defaultValue: 'Runs out' })
                          : t('quota_management.forecast_resets', { defaultValue: 'Resets' })}
                      </span>
                      {formatInstant(target)}
                      <span className={styles.etaRelative}>
                        {formatRelativeInstant(target, now, i18n.resolvedLanguage)}
                      </span>
                      {!forecast.fromHistory && (
                        <span
                          className={styles.estimate}
                          title={t('quota_management.forecast_average_hint', {
                            defaultValue:
                              'Not enough checkpoints yet; estimated from the whole-window average.',
                          })}
                        >
                          {t('quota_management.forecast_average', { defaultValue: 'avg' })}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
