-- "Coming soon" categories: listed in the picker with a "Soon" chip. They are
-- still playable (so App Review can test them on the latest build).
--
-- is_listed = false  -> hidden entirely (unchanged)
-- is_listed = true, coming_soon = true -> playable, flagged "Soon"
-- is_listed = true, coming_soon = false -> playable (default)
--
-- Only app builds that request `/api/categories?include=coming_soon` receive
-- these; older builds never see them.

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS coming_soon boolean NOT NULL DEFAULT false;

-- Teasing a category:
-- UPDATE public.categories SET is_listed = true, coming_soon = true WHERE id = '...';
--
-- Launching it (flip recently_added too so it gets the NEW badge):
-- UPDATE public.categories SET coming_soon = false, recently_added = true WHERE id = '...';
