export interface RowAction<T> {
  label: string;
  handler: (row: T) => void;
}
