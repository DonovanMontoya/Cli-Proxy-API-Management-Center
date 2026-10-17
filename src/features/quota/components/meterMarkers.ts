/**
 * Threshold ticks over a quota meter track: the marker shape and the host
 * class a track needs to carry them. Rendering lives in QuotaMeterMarkers.
 */

import markerStyles from './QuotaMeter.module.scss';

export interface QuotaMeterMarker {
  id: string;
  /** Position from the left edge, 0-100. */
  percent: number;
  /** critical = a hard stop; neutral = an informational threshold. */
  tone?: 'neutral' | 'critical';
  /** Tooltip and accessible name. */
  label: string;
}

/** A meter track's class, plus the marker-host class (lets ticks overhang) when it has markers. */
export const withMarkerHost = (
  className: string,
  markers: readonly QuotaMeterMarker[] | undefined
): string =>
  markers !== undefined && markers.length > 0
    ? `${className} ${markerStyles.markerHost}`
    : className;
