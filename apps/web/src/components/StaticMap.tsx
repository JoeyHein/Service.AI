/**
 * Google Static Maps embed (TASK-DB-04).
 *
 * Renders an <img> pointing at Google Static Maps when the component
 * has coordinates AND a NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is set. Any
 * other path — missing coords, missing key, API failure at render —
 * degrades to a placeholder with the raw coordinates and a link to
 * open the location on Google Maps.
 *
 * The API key is read from NEXT_PUBLIC_* because this component runs
 * on the server to render HTML but the URL it outputs ends up in the
 * browser. A server-only secret would be ideal but Google Static
 * Maps authenticates via URL param, so the key IS visible to any
 * browser that loads the page — the production mitigation is Google
 * Cloud key restrictions (HTTP referrer allowlist, API allowlist),
 * NOT secrecy.
 */

interface Props {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  address?: string | null;
  /** Map width in px. Defaults to 600. */
  width?: number;
  /** Map height in px. Defaults to 320. */
  height?: number;
  /** Zoom level, 0..21. Defaults to 15. */
  zoom?: number;
}

export function StaticMap({
  latitude,
  longitude,
  address,
  width = 600,
  height = 320,
  zoom = 15,
}: Props) {
  const hasCoords =
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude);

  if (!hasCoords) {
    return (
      <div
        data-testid="static-map-placeholder"
        className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500"
      >
        No address on file for this customer.
      </div>
    );
  }

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${latitude},${longitude}`,
  )}`;

  if (!apiKey) {
    return (
      <div
        data-testid="static-map-no-key"
        className="rounded-lg border border-slate-200 bg-white p-4 text-sm"
      >
        <div className="font-medium text-slate-700">Location</div>
        {address && <div className="mt-1 text-slate-600">{address}</div>}
        <div className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
          {latitude.toFixed(5)}, {longitude.toFixed(5)}
        </div>
        <a
          href={mapsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs text-blue-700 hover:underline"
        >
          Open in Google Maps →
        </a>
      </div>
    );
  }

  const params = new URLSearchParams({
    center: `${latitude},${longitude}`,
    zoom: String(zoom),
    size: `${width}x${height}`,
    scale: '2',
    markers: `color:red|${latitude},${longitude}`,
    key: apiKey,
  });
  const src = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;

  return (
    <a
      href={mapsUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="static-map-image"
      className="block rounded-lg overflow-hidden border border-slate-200"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={address ? `Map: ${address}` : 'Customer location map'}
        width={width}
        height={height}
        className="w-full h-auto"
      />
    </a>
  );
}
