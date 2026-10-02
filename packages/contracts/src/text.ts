/** Postgres text cannot hold NUL, so reject it at validation instead of failing in a query. */
export const noNul = (value: string): boolean => !value.includes('\u0000')
