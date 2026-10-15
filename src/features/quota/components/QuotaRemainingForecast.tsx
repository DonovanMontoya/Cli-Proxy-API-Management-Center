/**
 * Remaining quota chart: the total across every credential, recorded up to now
 * (solid) and projected forward (dashed), stepping up whenever a credential's
 * window renews (see remainingForecastModel.ts).
 */

import { useMemo, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  DEFAULT_FORECAST_RANGE,
  FORECAST_RANGES,
  forecastRemaining,
  nextReset,
  pastSpanMs,
  remainingTicks,
  type RemainingCredential,
  type RemainingPoint,
} from '../remainingForecastModel';
import { useElementWidth } from '../useElementWidth';
import styles from './QuotaChart.module.scss';

const CHART_HEIGHT = 220;
const PAD = { top: 22, right: 8, bottom: 28, left: 44 };

const RANGE_LABELS: Record<string, string> = {
  '24h': '24 hours',
  '3d': '3 days',
  '7d': '7 days',
  '14d': '14 days',
};

const formatMoment = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Local midnights inside the span, thinned to a handful of labels. */
function dayTicks(fromMs: number, toMs: number): number[] {
  const midnights: number[] = [];
  const d = new Date(fromMs);
  d.setHours(24, 0, 0, 0);
  while (d.getTime() <= toMs) {
    midnights.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  const step = Math.max(1, Math.ceil(midnights.length / 6));
  return midnights.filter((_, i) => i % step === 0);
}

export interface QuotaRemainingForecastProps {
  credentials: readonly RemainingCredential[];
  now: number;
  color: string;
}

export function QuotaRemainingForecast({ credentials, now, color }: QuotaRemainingForecastProps) {
  const { t } = useTranslation();
  const [rangeId, setRangeId] = useState(DEFAULT_FORECAST_RANGE);
  const range = FORECAST_RANGES.find((r) => r.id === rangeId) ?? FORECAST_RANGES[2];
  const futureMs = range.hours * HOUR_MS;
  const [hover, setHover] = useState<RemainingPoint | null>(null);

  const forecast = useMemo(
    () => forecastRemaining(credentials, now, futureMs),
    [credentials, now, futureMs]
  );
  const upcoming = useMemo(() => nextReset(credentials, now), [credentials, now]);
  const points = useMemo(
    () => [...forecast.past, ...forecast.future.slice(forecast.past.length ? 1 : 0)],
    [forecast]
  );

  const [chartRef, width] = useElementWidth<HTMLDivElement>();

  const from = now - pastSpanMs(futureMs);
  const to = now + futureMs;
  const plotW = Math.max(100, width - PAD.left - PAD.right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const x = (ms: number) => PAD.left + ((ms - from) / (to - from)) * plotW;
  const y = (remaining: number) => baseY - (remaining / forecast.capacity) * plotH;
  const path = (list: readonly RemainingPoint[]) =>
    `M${list.map((p) => `${x(p.t)},${y(p.remaining)}`).join('L')}`;

  const xTicks =
    range.hours * HOUR_MS >= 3 * DAY_MS
      ? dayTicks(from, to)
      : Array.from({ length: 5 }, (_, i) => from + ((to - from) * i) / 4);
  const formatTick = (ms: number) =>
    range.hours >= 72
      ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const at = from + ((event.clientX - rect.left - PAD.left) / plotW) * (to - from);
    const inside = points.filter((p) => p.t >= from);
    if (!inside.length || at < from || at > to) return setHover(null);
    setHover(
      inside.reduce((best, p) => (Math.abs(p.t - at) < Math.abs(best.t - at) ? p : best), inside[0])
    );
  };

  const rangeOptions = FORECAST_RANGES.map((r) => ({
    value: r.id,
    label: t(`quota_management.forecast_range_${r.id}`, { defaultValue: RANGE_LABELS[r.id] }),
  }));

  return (
    <div className={styles.drain} style={{ '--series': color } as CSSProperties}>
      <div className={styles.legendRow}>
        <span className={styles.legend}>
          <span className={styles.swatch} />
          {t('quota_management.forecast_remaining', { defaultValue: 'Remaining' })}
          <span className={styles.projected} />
          {t('quota_management.forecast_projected', { defaultValue: 'Projected' })}
        </span>
        <span className={styles.show}>
          {t('quota_management.forecast_next', { defaultValue: 'Next' })}
          <Select
            size="sm"
            value={range.id}
            options={rangeOptions}
            onChange={setRangeId}
            ariaLabel={t('quota_management.forecast_next', { defaultValue: 'Next' })}
          />
        </span>
      </div>

      <div className={styles.chart} ref={chartRef}>
        <svg
          width={width}
          height={CHART_HEIGHT}
          role="img"
          aria-label="Remaining quota forecast"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="remaining-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.03} />
            </linearGradient>
          </defs>

          {remainingTicks(forecast.capacity).map((value) => (
            <g key={value}>
              <line
                className={styles.gridLine}
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={y(value)}
                y2={y(value)}
              />
              <text
                className={styles.axisText}
                x={PAD.left - 10}
                y={y(value)}
                dy="0.32em"
                textAnchor="end"
              >
                {Math.round(value)}%
              </text>
            </g>
          ))}
          {xTicks.map((ms) => (
            <text
              key={ms}
              className={styles.axisText}
              x={x(ms)}
              y={CHART_HEIGHT - 8}
              textAnchor="middle"
            >
              {formatTick(ms)}
            </text>
          ))}

          <path
            d={`${path(points)}L${x(points[points.length - 1].t)},${baseY}L${x(points[0].t)},${baseY}Z`}
            fill="url(#remaining-fill)"
          />
          {forecast.past.length > 1 && <path className={styles.line} d={path(forecast.past)} />}
          <path className={styles.projection} d={path(forecast.future)} />

          <line className={styles.nowLine} x1={x(now)} x2={x(now)} y1={PAD.top} y2={baseY} />
          <text className={styles.nowText} x={x(now) + 6} y={PAD.top - 8}>
            {t('quota_management.windows_now', { defaultValue: 'Now' })}
          </text>

          {hover && (
            <g>
              <line
                className={styles.hoverLine}
                x1={x(hover.t)}
                x2={x(hover.t)}
                y1={PAD.top}
                y2={baseY}
              />
              <circle className={styles.hoverDot} cx={x(hover.t)} cy={y(hover.remaining)} r={4} />
            </g>
          )}
        </svg>
        {hover && (
          <div
            className={styles.tooltip}
            style={{
              left: Math.min(Math.max(x(hover.t), PAD.left + 60), width - 60),
              top: y(hover.remaining) - 10,
            }}
          >
            {t('quota_management.forecast_tooltip', {
              defaultValue: '{{when}} · {{value}}% left',
              when: formatMoment(hover.t),
              value: Math.round(hover.remaining),
            })}
          </div>
        )}
      </div>

      {upcoming && (
        <p className={styles.footnote}>
          {t('quota_management.forecast_next_reset', {
            defaultValue: 'Next reset +{{gain}}% · {{when}}',
            gain: Math.round(upcoming.gain),
            when: formatMoment(upcoming.atMs),
          })}
        </p>
      )}
    </div>
  );
}
