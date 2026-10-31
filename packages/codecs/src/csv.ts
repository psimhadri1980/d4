/** One CSV field, quoted when it holds a comma, quote or line break (RFC 4180). */
export const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
