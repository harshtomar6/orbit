const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function formatCompactCount(value: number): string {
  return compactNumber.format(value).replaceAll("K", "k").replaceAll("M", "m").replaceAll("B", "b").replaceAll("T", "t");
}
