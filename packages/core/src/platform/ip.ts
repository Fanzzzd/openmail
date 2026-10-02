const ipv4 = (value: string) => {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  );
};

/** Strict IP literal parsing, shared by all transports before DNS results are accepted. */
export function isIP(address: string): 0 | 4 | 6 {
  if (ipv4(address)) return 4;
  const [value = "", zone, extra] = address.split("%");
  if (extra !== undefined || (zone !== undefined && !/^[0-9a-z.:-]+$/i.test(zone))) return 0;
  if (!value.includes(":")) return 0;
  const halves = value.split("::");
  if (halves.length > 2) return 0;
  const parts = halves.flatMap((half) => (half ? half.split(":") : []));
  let count = 0;
  for (const [index, part] of parts.entries()) {
    if (/^[a-f\d]{1,4}$/i.test(part)) count++;
    else if (index === parts.length - 1 && value.endsWith(part) && ipv4(part)) count += 2;
    else return 0;
  }
  return (halves.length === 2 ? count < 8 : count === 8) ? 6 : 0;
}
