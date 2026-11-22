# KnowUsBetter translation rules (all languages)

KnowUsBetter is a quiz game for couples (and friends). Two players answer the same
questions on one phone or two, then compare. Players are adults in their 20s-30s.
The app never knows a player's gender, and couples can be any combination of genders.

## Source
- English is the source of truth for meaning. Turkish (`tr`) is the original author's
  language and shows tone and nuance; Spanish/Portuguese show how a sister language solved it.
- Translate meaning and feel, not words. A native speaker must not be able to tell it was translated.

## Hard rules (machine-checked where possible)
1. Placeholders: keep every `{{playerName}}` exactly, character for character. Never translate,
   inflect, add a suffix to, or add a placeholder. `{{playerName}}` only appears in question text,
   never in answer options.
2. Answer options: same count, same order, same meaning as English. Short, parallel, distinct.
   No two options may be identical. An option must not be the exact text of a *different* option
   in another language.
3. No slash/bracket gender forms anywhere: no "(a)", "/a", "/in", ":in", "*in", "-(a)", "o/a",
   "ł(a)", "łeś/łaś". Rephrase instead (see the language file for patterns).
4. Nothing may require knowing the gender of the player, of {{playerName}}, of the partner, or of
   the two players together (they can be two women, two men, or mixed). This covers verbs,
   participles, adjectives, nouns, pronouns and plural agreement.
5. Same length as the English or shorter where possible. It is read on a phone in a few seconds.
6. Correct spelling with all diacritics and the language's own punctuation and quotation marks.
7. Keep the register: casual, warm, playful. Intimate categories (spicy, *_intimacy) are flirty
   and adult but never vulgar, crude or clinical.
8. Brands, apps, shows, songs and people stay as they are known in the target country.

## Per game mode
- see_your_match (just_friends, we_just_met, long_term, spicy, daily_*): both players answer
  about themselves. "you" = the player answering. Options must work from both sides
  (no "me"/"you"-relative options that would stop answers from matching).
- know_each_other (know_me_well*, ...): questions are about {{playerName}}; one player answers,
  the other guesses. Third person about {{playerName}} without any gendered word.
- who_knows_better (trivia_master, mastermind): general-knowledge quiz with an answer key.
  Facts must stay exactly true. Use the target language's standard names for places, people,
  works and things. `accepted` (typed-answer key) lists the main spelling first, then common
  alternatives, abbreviations, spelling without diacritics if people type that, and the English
  name if locals use it. Flag anything whose answer depends on the country.
- who_is_more_likely: the text is always the language's standard "Who is more likely to ...?"
  frame. The app shows the vote buttons itself (no answer options).
- rank_it: keep the ranking direction (most -> least, hardest -> easiest). Options short, parallel.
- two_truths: the text is a short topic noun phrase addressed to the player ("Your childhood"),
  not a question.
- Yes/no questions have no answer options; the app shows Yes/No.

## Flagging
Set `flagged: true` with a short English `note` when a human should look: a cultural reference
that doesn't land in the target country, an ambiguous source, a trivia fact that depends on the
country, or a sentence where gender-neutral wording forced a compromise you're unsure about.
