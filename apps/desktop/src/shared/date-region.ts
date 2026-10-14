/** Where the renderer's date formats come from: the OS region and its 12 or 24-hour clock. */
export interface DateRegion {
  readonly region: string | undefined;
  readonly hourCycle: "h12" | "h23" | undefined;
}

/** Page query fields; main sets them, the renderer reads them before it renders. */
export function dateRegionQuery({ region, hourCycle }: DateRegion): Record<string, string> {
  return {
    ...(region ? { region } : {}),
    ...(hourCycle ? { hourCycle } : {}),
  };
}

export function readDateRegion(query: URLSearchParams): DateRegion {
  const hourCycle = query.get("hourCycle");
  return {
    region: query.get("region") ?? undefined,
    hourCycle: hourCycle === "h12" || hourCycle === "h23" ? hourCycle : undefined,
  };
}

/**
 * The locale for dates: the OS region when it speaks the UI language (en-GB under English),
 * else the UI language with its own default region.
 */
export function dateLocale(uiLocale: string, region: string | undefined): string {
  if (!region) return uiLocale;
  try {
    const regional = new Intl.Locale(region);
    return regional.language === new Intl.Locale(uiLocale).language ? regional.baseName : uiLocale;
  } catch {
    return uiLocale;
  }
}
