export interface BaseRowAction<T> {
  label: string;
}

export interface WithOptions<T> extends BaseRowAction<T> {
  options: (row: T) => WithHandler<T>[];
  handler?: never;
}

export interface WithHandler<T> extends BaseRowAction<T> {
  options?: never;
  handler: (row: T) => void;
}

export type RowAction<T> = WithOptions<T> | WithHandler<T>;
