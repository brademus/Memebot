// PostgreSQL timestamp values are validated immediately after Date construction in
// Evidence System v3. The pg driver value is typed as unknown at the generic query
// boundary, so expose the runtime Date constructor contract used by that validator.
interface DateConstructor {
  new(value: unknown): Date;
}
