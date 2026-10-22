-- Reactions players can send each other during a game (services/reactionService.ts).
-- Read only by the backend (service role) and served at /api/reactions; RLS
-- with no policies blocks every other client.
--
-- coin_cost 0 = free. animation picks how it plays on the partner's screen:
--   float: rises with a trail of small copies   burst: pops and scatters
--   shake: wobbles angrily                      rain:  falls across the screen
-- color tints the glow behind the emoji (hex, #RRGGBB).
-- labels: { "en": "...", "tr": "...", "es": "..." }

CREATE TABLE IF NOT EXISTS public.game_reactions (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{1,40}$'),
  emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  coin_cost integer NOT NULL DEFAULT 0 CHECK (coin_cost BETWEEN 0 AND 100),
  animation text NOT NULL DEFAULT 'float'
    CHECK (animation IN ('float', 'burst', 'shake', 'rain')),
  color text NOT NULL DEFAULT '#C94B6A' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  order_index integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_reactions_order_idx
  ON public.game_reactions (order_index);

DROP TRIGGER IF EXISTS update_game_reactions_updated_at ON public.game_reactions;
CREATE TRIGGER update_game_reactions_updated_at
  BEFORE UPDATE ON public.game_reactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.game_reactions ENABLE ROW LEVEL SECURITY;

INSERT INTO public.game_reactions
  (id, emoji, labels, coin_cost, animation, color, order_index)
VALUES
  ('love', '❤️', '{"en": "Love", "tr": "Aşk", "es": "Amor"}', 0, 'float', '#E0456B', 1),
  ('laugh', '😂', '{"en": "Haha", "tr": "Kahkaha", "es": "Jaja"}', 0, 'burst', '#F5A524', 2),
  ('kiss', '😘', '{"en": "Kiss", "tr": "Öpücük", "es": "Beso"}', 1, 'burst', '#EC6A9C', 3),
  ('angry', '😡', '{"en": "Grr", "tr": "Kızgın", "es": "Enojo"}', 1, 'shake', '#E0453A', 4),
  ('eye_roll', '🙄', '{"en": "Eye roll", "tr": "Göz devirme", "es": "Ojos en blanco"}', 1, 'float', '#8B7CF6', 5),
  ('fire', '🔥', '{"en": "On fire", "tr": "Ateş", "es": "Fuego"}', 2, 'rain', '#F97316', 6)
ON CONFLICT (id) DO NOTHING;
