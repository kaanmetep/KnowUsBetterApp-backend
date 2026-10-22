-- Reactions now show the app's own sticker art (matched by id in
-- app/(components)/game/reactions/ReactionArt.tsx); emoji stays as the
-- fallback for builds that don't have a sticker for an id.
-- eye_roll gives way to shy; colors follow the stickers' palette.

UPDATE public.game_reactions SET is_active = false WHERE id = 'eye_roll';

INSERT INTO public.game_reactions
  (id, emoji, labels, coin_cost, animation, color, order_index)
VALUES
  ('shy', '😊', '{"en": "Shy", "tr": "Utangaç", "es": "Tímido"}', 1, 'float', '#F2808C', 3)
ON CONFLICT (id) DO NOTHING;

UPDATE public.game_reactions AS r
SET color = v.color, order_index = v.order_index
FROM (VALUES
  ('love', '#F0727F', 1),
  ('laugh', '#F2A65A', 2),
  ('shy', '#F2808C', 3),
  ('kiss', '#E2819A', 4),
  ('angry', '#D8664F', 5),
  ('fire', '#F08A4B', 6)
) AS v (id, color, order_index)
WHERE r.id = v.id;
