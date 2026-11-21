# staging/ rules

- Live-applied migrations whose files are missing from `drizzle/migrations/` (only the migration tool may write there) are kept here as byte-exact reference copies with their journal entries (`applied-migrations-*`); never hand-copy them back or re-run them without owner approval.
