/**
 * Quota level bar (the typed successor of QuotaProgressBar).
 *
 * dataviz grammar: a thin track recedes into the background and the fill is
 * coloured by remaining share in three steps (>=70 green / >=30 amber / <30 red).
 * percent === null renders an empty track: unknown is never coloured.
 * `index` feeds `--meter-index` so the full-page skin can stagger rows on entry;
 * the compact skin ignores it.
 *
 * Optional `markers` draw thin threshold ticks over the track. The markers
 * stylesheet belongs to this component rather than the host class contract,
 * so hosts and providers without markers are unaffected.
 */

import type { CSSProperties } from 'react';
import type { QuotaClassMap } from '../types';
import { withMarkerHost, type QuotaMeterMarker } from './meterMarkers';
import markerStyles from './QuotaMeter.module.scss';

export type { QuotaMeterMarker };

export const QUOTA_PROGRESS_HIGH_THRESHOLD = 70;
export const QUOTA_PROGRESS_MEDIUM_THRESHOLD = 30;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Renders inside a track whose class went through withMarkerHost; nothing without markers. */
export function QuotaMeterMarkers({ markers }: { markers?: readonly QuotaMeterMarker[] }) {
  if (markers === undefined || markers.length === 0) return null;
  return (
    <>
      {markers.map((marker) => (
        <span
          key={marker.id}
          role="img"
          aria-label={marker.label}
          title={marker.label}
          className={
            marker.tone === 'critical'
              ? `${markerStyles.marker} ${markerStyles.markerCritical}`
              : markerStyles.marker
          }
          style={{ left: `${clamp(marker.percent, 0, 100)}%` }}
        />
      ))}
    </>
  );
}

export interface QuotaMeterProps {
  percent: number | null;
  classes: QuotaClassMap;
  index?: number;
  markers?: readonly QuotaMeterMarker[];
}

export function QuotaMeter({ percent, classes, index, markers }: QuotaMeterProps) {
  const normalized = percent === null ? null : clamp(percent, 0, 100);
  const fillClass =
    normalized === null
      ? classes.quotaBarFillMedium
      : normalized >= QUOTA_PROGRESS_HIGH_THRESHOLD
        ? classes.quotaBarFillHigh
        : normalized >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
          ? classes.quotaBarFillMedium
          : classes.quotaBarFillLow;
  const widthPercent = Math.round((normalized ?? 0) * 100) / 100;
  const style: CSSProperties & { '--meter-index'?: number } = { width: `${widthPercent}%` };
  if (index !== undefined) {
    style['--meter-index'] = index;
  }
  return (
    <div className={withMarkerHost(classes.quotaBar, markers)}>
      <div className={`${classes.quotaBarFill} ${fillClass}`} style={style} />
      <QuotaMeterMarkers markers={markers} />
    </div>
  );
}
