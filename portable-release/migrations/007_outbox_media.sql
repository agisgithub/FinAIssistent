ALTER TABLE outbox ADD COLUMN media_type TEXT CHECK(media_type IS NULL OR media_type = 'image/png');
ALTER TABLE outbox ADD COLUMN media_filename TEXT CHECK(media_filename IS NULL OR (length(media_filename) BETWEEN 5 AND 100 AND media_filename GLOB '*.png'));
ALTER TABLE outbox ADD COLUMN media_blob BLOB CHECK(
  (media_type IS NULL AND media_filename IS NULL AND media_blob IS NULL)
  OR (media_type = 'image/png' AND media_filename IS NOT NULL AND typeof(media_blob) = 'blob' AND length(media_blob) BETWEEN 9 AND 2097152)
);
