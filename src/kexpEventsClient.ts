import { load } from 'cheerio';

const KEXP_IN_STUDIO_EVENTS_URL = 'https://kexp.org/events/kexp-events/?category=in-studio';
const EVENTS_CACHE_TTL_MS = 10 * 60 * 1000;

export interface KexpInStudioEvent {
  id: string;
  title: string;
  url: string;
  date_text: string;
  date_iso: string;
  time_text: string;
  venue: string | null;
  photo_credit: string | null;
  is_open_to_public: boolean;
}

type ParsedEvent = {
  title: string;
  url: string;
  date_text: string;
  time_text: string;
  venue: string | null;
  photo_credit: string | null;
};

let inStudioEventsCache:
  | { fetchedAtMs: number; events: KexpInStudioEvent[] }
  | null = null;

function parseDateHeading(dateText: string): string {
  const strippedPrefix = dateText.replace(/^[A-Za-z]+,\s*/, '').trim();
  const parsed = new Date(`${strippedPrefix} 12:00 PM`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unable to parse event date heading: "${dateText}"`);
  }

  return parsed.toISOString().slice(0, 10);
}

function normalizeTimeText(timeText: string): string {
  return timeText
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function buildEventId(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const slug = pathname
      .replace(/^\/events\/kexp-events\//, '')
      .replace(/\/$/, '');

    if (slug) {
      return slug;
    }
  } catch {
    // Fall through to normalized URL fallback.
  }

  return url.toLowerCase();
}

function isLikelyEventTitle(anchorText: string): boolean {
  if (!anchorText) {
    return false;
  }

  return !/^(MORE|FACEBOOK|COPY LINK|ADD TO CALENDAR)$/i.test(anchorText.trim());
}

function parseInStudioEventsFromHtml(html: string): KexpInStudioEvent[] {
  const $ = load(html);
  const eventsByUrl = new Map<string, ParsedEvent>();

  // Events on this page are grouped by date heading (h2) and time (h5).
  let currentDateHeading = '';
  let currentTimeHeading = '';
  let currentEventUrl = '';

  const orderedNodes = $('h2, h5, a[href], [class*="photo" i], [id*="photo" i]');
  orderedNodes.each((_, node) => {
    const element = $(node);
    const tagName = node.tagName?.toLowerCase() ?? '';

    if (tagName === 'h2') {
      currentDateHeading = element.text().trim();
      currentTimeHeading = '';
      currentEventUrl = '';
      return;
    }

    if (tagName === 'h5') {
      currentTimeHeading = element.text().trim();
      return;
    }

    if (tagName === 'a') {
      const href = element.attr('href')?.trim();
      if (!href) {
        return;
      }

      const absoluteHref = new URL(href, 'https://kexp.org').toString();
      const text = element.text().replace(/\s+/g, ' ').trim();

      if (/maps\.google\.com/i.test(absoluteHref)) {
        if (currentEventUrl) {
          const prior = eventsByUrl.get(currentEventUrl);
          if (prior && !prior.venue) {
            prior.venue = text || null;
          }
        }
        return;
      }

      if (!/\/events\/kexp-events\//i.test(absoluteHref)) {
        return;
      }

      if (!isLikelyEventTitle(text) || !currentDateHeading || !currentTimeHeading) {
        return;
      }

      if (!eventsByUrl.has(absoluteHref)) {
        eventsByUrl.set(absoluteHref, {
          title: text,
          url: absoluteHref,
          date_text: currentDateHeading,
          time_text: currentTimeHeading,
          venue: null,
          photo_credit: null,
        });
      }

      currentEventUrl = absoluteHref;
      return;
    }

    if (currentEventUrl) {
      const text = element.text().replace(/\s+/g, ' ').trim();
      if (/^PHOTO\s+/i.test(text)) {
        const prior = eventsByUrl.get(currentEventUrl);
        if (prior && !prior.photo_credit) {
          prior.photo_credit = text;
        }
      }
    }
  });

  const events = Array.from(eventsByUrl.values()).map((event) => ({
    id: buildEventId(event.url),
    title: event.title,
    url: event.url,
    date_text: event.date_text,
    date_iso: parseDateHeading(event.date_text),
    time_text: normalizeTimeText(event.time_text),
    venue: event.venue,
    photo_credit: event.photo_credit,
    is_open_to_public: /\(OPEN TO THE PUBLIC\)/i.test(event.title),
  }));

  events.sort((a, b) => {
    const dateCompare = a.date_iso.localeCompare(b.date_iso);
    if (dateCompare !== 0) {
      return dateCompare;
    }
    return a.title.localeCompare(b.title);
  });

  return events;
}

export async function fetchKexpInStudioEvents(): Promise<KexpInStudioEvent[]> {
  const now = Date.now();
  if (inStudioEventsCache && now - inStudioEventsCache.fetchedAtMs < EVENTS_CACHE_TTL_MS) {
    return inStudioEventsCache.events;
  }

  const response = await fetch(KEXP_IN_STUDIO_EVENTS_URL, {
    signal: AbortSignal.timeout(12_000),
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'kexp-mcp-server/1.0 (+https://github.com/randyramig/kexp_mcp_server)',
    },
  });

  if (!response.ok) {
    throw new Error(`KEXP events page request failed (${response.status} ${response.statusText}).`);
  }

  const html = await response.text();
  const events = parseInStudioEventsFromHtml(html);
  inStudioEventsCache = { fetchedAtMs: now, events };
  return events;
}

export function clearInStudioEventsCache(): void {
  inStudioEventsCache = null;
}
