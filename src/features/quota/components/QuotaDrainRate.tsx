/**
 * Drain rate chart: percentage points of quota consumed per hour, summed across
 * the credentials on the page, as a 1-hour moving average (see drainRateModel.ts).
 */

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { HOUR_MS } from '@/utils/time/durations';
import {
  DEFAULT_DRAIN_RANGE,
  DRAIN_RANGES,
  drainAxis,
  drainRuns,
  drainSamples,
  formatDrainRate,
} from '../drainRateModel';
import type { UsageCheckpoint } from '../usageHistory';
import { useElementWidth } from '../useElementWidth';
import styles from './QuotaChart.module.scss';

const CHART_HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 28, left: 36 };

const RANGE_LABELS: Record<string, string> = {
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '3d': 'Last 3 days',
};

export interface QuotaDrainRateProps {
  /** Recorded checkpoints per credential, already extended to `now`. */
  series: readonly (readonly UsageCheckpoint[])[];
  now: number;
  color: string;
}

export function QuotaDrainRate({ series, now, color }: QuotaDrainRateProps) {
  const { t } = useTranslation();
  const [rangeId, setRangeId] = useState(DEFAULT_DRAIN_RANGE);
  const range = DRAIN_RANGES.find((r) => r.id === rangeId) ?? DRAIN_RANGES[1];
  const rangeMs = range.hours * HOUR_MS;

  const samples = useMemo(() => drainSamples(series, now, rangeMs), [series, now, rangeMs]);
  const runs = useMemo(() => drainRuns(samples), [samples]);
  const peak = samples.reduce((max, s) => Math.max(max, s.rate ?? 0), 0);
  const axis = drainAxis(peak);

  const [chartRef, width] = useElementWidth<HTMLDivElement>();

  const from = now - rangeMs;
  const plotW = Math.max(100, width - PAD.left - PAD.right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const x = (ms: number) => PAD.left + ((ms - from) / rangeMs) * plotW;
  const y = (rate: number) => baseY - (rate / axis.max) * plotH;

  const xTickCount = Math.max(2, Math.min(5, Math.floor(plotW / 140)));
  const xTicks = Array.from(
    { length: xTickCount + 1 },
    (_, i) => from + (rangeMs * i) / xTickCount
  );
  const formatTick = (ms: number) =>
    new Date(ms).toLocaleString(
      undefined,
      range.hours > 24
        ? { month: 'short', day: 'numeric', hour: 'numeric' }
        : { hour: 'numeric', minute: '2-digit' }
    );

  const hasData = runs.length > 0;
  const rangeOptions = DRAIN_RANGES.map((r) => ({
    value: r.id,
    label: t(`quota_management.drain_range_${r.id}`, { defaultValue: RANGE_LABELS[r.id] }),
  }));

  return (
    <div className={styles.drain} style={{ '--series': color } as CSSProperties}>
      <div className={styles.legendRow}>
        <span className={styles.legend}>
          <span className={styles.swatch} />
          {t('quota_management.drain_unit', { defaultValue: '% per hour' })}
          <span className={styles.legendNote}>
            {t('quota_management.drain_average', { defaultValue: '1-hour average' })}
          </span>
        </span>
        <span className={styles.show}>
          {t('quota_management.drain_show', { defaultValue: 'Show' })}
          <Select
            size="sm"
            value={range.id}
            options={rangeOptions}
            onChange={setRangeId}
            ariaLabel={t('quota_management.drain_show', { defaultValue: 'Show' })}
          />
        </span>
      </div>

      <div className={styles.chart} ref={chartRef}>
        <svg width={width} height={CHART_HEIGHT} role="img" aria-label="Drain rate">
          <defs>
            <linearGradient id="drain-rate-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0.03} />
            </linearGradient>
          </defs>

          {axis.ticks.map((value) => (
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
                {formatDrainRate(value)}
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
              {formatTick(ms)}
            </text>
          ))}

          {runs.map((run) => {
            const points = run.map((p) => `${x(p.t)},${y(p.rate)}`);
            if (run.length === 1) {
              return (
                <circle
                  key={run[0].t}
                  className={styles.lone}
                  cx={x(run[0].t)}
                  cy={y(run[0].rate)}
                  r={2}
                />
              );
            }
            const line = `M${points.join('L')}`;
            const area = `${line}L${x(run[run.length - 1].t)},${baseY}L${x(run[0].t)},${baseY}Z`;
            return (
              <g key={run[0].t}>
                <path d={area} fill="url(#drain-rate-fill)" />
                <path className={styles.line} d={line} />
              </g>
            );
          })}
        </svg>
        {!hasData && (
          <div className={styles.empty} role="status">
            {t('quota_management.drain_empty', {
              defaultValue:
                'Not enough history yet. The drain rate fills in as quota readings are recorded.',
            })}
          </div>
        )}
      </div>

      <p className={styles.footnote}>
        {[
          t('quota_management.drain_peak', {
            defaultValue: 'Peak {{value}} % per hour',
            value: formatDrainRate(peak),
          }),
          t('quota_management.drain_all_accounts', { defaultValue: 'All accounts' }),
          t('quota_management.drain_resets_excluded', { defaultValue: 'Resets excluded' }),
          t('quota_management.drain_gaps', { defaultValue: 'Gaps mean missing history' }),
        ].join(' · ')}
      </p>
    </div>
  );
}
