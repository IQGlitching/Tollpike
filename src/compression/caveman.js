// Caveman — lossy natural-language compression.
//
// Prose written for humans carries grammar the model does not need in order
// to recover the meaning: articles, copulas, most prepositions, politeness
// scaffolding. Stripping it produces telegraphic "caveman speak" that reads
// badly and costs 30-60% fewer tokens. On a coding-agent transcript, where
// most of the context is old assistant explanation, that is the single
// largest cheap win available.
//
// This is LOSSY. Two rules make it safe enough to run on real traffic:
//
//   1. Anything that must survive byte-exact is protected and never touched:
//      fenced code, inline code, URLs, paths, identifiers, numbers, and any
//      line that looks like code rather than prose.
//   2. Words whose removal INVERTS meaning are never dropped. Dropping "not"
//      from "do not delete the table" is not a compression bug, it is a
//      destroyed instruction. NEVER_DROP is that list, and it takes
//      precedence over every other rule here.
//
// Scope is decided by the caller, not here — see compress.js. The default
// never applies this to a system prompt or to the newest user turn, because
// those are the two places where the operator's exact wording matters most.

// Multi-word scaffolding, removed before tokenizing. These carry no
// information at all in an instruction-following context.
const FILLER_PHRASES = [
  /\bplease note that\b/gi,
  /\bit is (?:important|worth) (?:to note|noting) that\b/gi,
  /\bit should be noted that\b/gi,
  /\bas (?:you can see|mentioned (?:above|earlier|before))\b/gi,
  /\bin (?:my|our) opinion\b/gi,
  /\bi (?:would|will) like to\b/gi,
  /\bfeel free to\b/gi,
  /\bjust to be clear\b/gi,
  /\bkeep in mind that\b/gi,
  /\bthat (?:being|said) said\b/gi,
  /\bat the end of the day\b/gi,
  /\bfor (?:what|all) it'?s worth\b/gi,
  /\bneedless to say\b/gi,
  /\bbasically\b/gi,
  /\bessentially\b/gi,
  /\bactually\b/gi,
  /\bcertainly\b/gi,
  /\bof course\b/gi,
  /\bkindly\b/gi,
  /\bplease\b/gi
];

// Verbose constructions with a shorter exact equivalent. Lossless in
// meaning, so these run at every level including "light".
const REWRITES = [
  [/\bin order to\b/gi, "to"],
  [/\bin the event that\b/gi, "if"],
  [/\bin the case (?:that|where)\b/gi, "if"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bfor the (?:purpose|purposes) of\b/gi, "for"],
  [/\bwith (?:regard|respect) to\b/gi, "re"],
  [/\bis able to\b/gi, "can"],
  [/\bare able to\b/gi, "can"],
  [/\bhas the ability to\b/gi, "can"],
  [/\bat this point in time\b/gi, "now"],
  [/\ba (?:large|great) number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\bin addition to\b/gi, "plus"],
  [/\bas a (?:result|consequence) of\b/gi, "from"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\bmake (?:a|an) (?:decision|attempt) to\b/gi, "decide to"]
];

// Dropped at level "aggressive". Articles, copulas, and the prepositions an
// LLM reliably re-infers from word order.
const DROPPABLE = new Set([
  "a", "an", "the",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "as", "into",
  "that", "this", "these", "those",
  "it", "its", "there", "here",
  "very", "quite", "rather", "really", "simply", "somewhat", "fairly",
  "then", "also", "just", "so"
]);

// Never removed, whatever the level. Every entry here either inverts meaning
// (negation), gates it (conditionals), or scopes it (quantifiers). A caveman
// pass that eats one of these turns an instruction into its opposite, which
// is far worse than paying for the token.
const NEVER_DROP = new Set([
  "not", "no", "never", "none", "nor", "cannot", "cant", "dont", "doesnt",
  "didnt", "wont", "isnt", "arent", "wasnt", "werent", "shouldnt", "wouldnt",
  "without", "except", "unless", "but", "however", "instead",
  "if", "else", "when", "while", "until", "before", "after", "because",
  "must", "should", "shall", "may", "might", "can", "will", "would",
  "only", "all", "any", "every", "each", "both", "either", "neither",
  "and", "or", "than", "vs"
]);

// Segments protected byte-exact. Order matters: fenced blocks first, so a
// backtick inside a fence isn't mistaken for an inline-code delimiter.
const PROTECTED = new RegExp(
  [
    "```[\\s\\S]*?```", // fenced code block
    "~~~[\\s\\S]*?~~~", // alternate fence
    "`[^`\\n]+`", // inline code
    "<[^>\\s][^>]*>", // tags / placeholders
    "https?://\\S+", // urls
    "[A-Za-z]:\\\\[^\\s\"']+", // windows path
    "(?:\\.{0,2}/)?(?:[\\w.@-]+/)+[\\w.@-]+", // posix path / package spec
    "\\$\\{?[A-Z_][A-Z0-9_]*\\}?", // env var
    "[\\w.-]*\\d[\\w.-]*", // any token containing a digit (versions, ids, sizes)
    "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+", // dotted identifier
    "[a-z]+(?:_[a-z0-9]+)+", // snake_case
    "[a-z]+(?:[A-Z][a-z0-9]*)+", // camelCase
    "[A-Z]{2,}" // acronym / constant
  ].join("|"),
  "g"
);

// A line that is code, not prose. Running a stopword pass over code
// produces syntactically broken code that reads as plausible, which is the
// worst possible failure mode here.
function looksLikeCode(line) {
  if (/^\s{4,}\S/.test(line)) return true; // indented block
  if (/^\s*(?:[|+\-]{2,}|[-=]{3,})/.test(line)) return true; // table / rule
  if (/[{};]\s*$/.test(line)) return true;
  if (/=>|::|->|\|\||&&|!==|===/.test(line)) return true;
  if (/^\s*(?:[#$>]|\d+[.)]\s|[-*]\s*\[)/.test(line)) return true; // shell, prompt, checkbox
  if (/^\s*[\w"'-]+\s*[:=]\s*\S/.test(line) && !/\s/.test(line.split(/[:=]/)[0].trim())) {
    return true; // key: value / key=value
  }
  const symbols = (line.match(/[^\w\s]/g) || []).length;
  return symbols > line.length * 0.25 && line.length > 8;
}

function stripPunctuationForLookup(word) {
  return word.replace(/[^\w']/g, "").replace(/'/g, "").toLowerCase();
}

// Drop droppable words from one prose run. Leading capitalisation is
// preserved by re-capitalising the first surviving word, so the result still
// reads as a sentence rather than starting mid-thought.
function cavemanRun(run) {
  const words = run.split(/(\s+)/); // keep the separators to rebuild spacing
  const kept = [];
  for (const part of words) {
    if (/^\s+$/.test(part)) {
      if (kept.length && !/^\s+$/.test(kept[kept.length - 1])) kept.push(" ");
      continue;
    }
    const lookup = stripPunctuationForLookup(part);
    if (lookup && DROPPABLE.has(lookup) && !NEVER_DROP.has(lookup)) {
      // Sentence-final punctuation attached to a dropped word has to
      // survive, or two sentences merge into one.
      const trailing = part.match(/[.!?,;:]+$/);
      if (trailing && kept.length) {
        const last = kept.length - 1;
        const idx = /^\s+$/.test(kept[last]) ? last - 1 : last;
        if (idx >= 0) kept[idx] += trailing[0];
      }
      continue;
    }
    kept.push(part);
  }
  let out = kept.join("").replace(/\s+/g, " ").trim();
  if (out && /^[a-z]/.test(out) && /^[A-Z]/.test(run.trim())) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  return out;
}

// Walk a prose line, applying cavemanRun only to the spans between protected
// segments.
//
// Rejoining is where this gets fiddly. cavemanRun trims, so the whitespace
// that separated a prose span from the protected token next to it is gone by
// the time we concatenate — and inferring "there was probably a space here"
// inserts one where the source had none. That turned the RTK marker
// `rows=6` into `rows= 6`, quietly corrupting machine-readable output that a
// separate pass had just generated. So the boundary is read off the ORIGINAL
// span and re-applied verbatim, never guessed.
function cavemanLine(line) {
  const glue = (prose) => {
    if (prose === "") return "";
    const lead = /^\s/.test(prose) ? " " : "";
    const trail = /\s$/.test(prose) ? " " : "";
    const body = cavemanRun(prose);
    if (!body) return lead || trail ? " " : "";
    return lead + body + trail;
  };

  let result = "";
  let cursor = 0;
  PROTECTED.lastIndex = 0;
  let match;
  while ((match = PROTECTED.exec(line)) !== null) {
    result += glue(line.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + glue(line.slice(cursor));
}

/**
 * @param {string} text
 * @param {{ level?: "off"|"light"|"aggressive" }} options
 *   light      — filler phrases and verbose constructions only (meaning-preserving)
 *   aggressive — additionally drops articles, copulas and inferable prepositions
 */
// Leading/trailing space and tab, as a character scan. `/^[ \t]+|[ \t]+$/g` is
// quadratic whenever the line ends in something other than whitespace: the
// trailing alternative matches the run, fails the end anchor, backtracks it all,
// and starts again one character along.
function trimHorizontal(line) {
  let start = 0;
  let end = line.length;
  const isHorizontal = (c) => c === 32 || c === 9; // space, tab
  while (start < end && isHorizontal(line.charCodeAt(start))) start++;
  while (end > start && isHorizontal(line.charCodeAt(end - 1))) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

export function caveman(text, { level = "light" } = {}) {
  if (!text || typeof text !== "string" || level === "off") return text;

  return text
    .split("\n")
    .map((line) => {
      if (looksLikeCode(line)) return line;

      let out = line;
      for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
      // Only the aggressive level drops words. "light" is the rewrite table
      // and nothing else, which is why it is safe to run on anything.
      if (level === "aggressive") {
        for (const pattern of FILLER_PHRASES) out = out.replace(pattern, "");
        out = cavemanLine(out);
      }
      // Collapse the gaps and orphaned punctuation the removals leave behind.
      //
      // The ORDER and the exact patterns here are load-bearing for performance,
      // not just for output. Two of these were quadratic:
      //
      //   /\s+([.,;:!?])/g   greedily eats a whitespace run, needs punctuation,
      //                      fails, backtracks the whole run, advances one and
      //                      repeats. The earlier `[ \t]{2,}` collapse did not
      //                      save it, because \r \v \f and NBSP are \s but are
      //                      not [ \t] — a line of carriage returns sailed past
      //                      the collapse straight into the quadratic pass.
      //   /[ \t]+$/          same shape, on a line ending in non-whitespace.
      //
      // Fixed by collapsing EVERY whitespace run first (\s{2,} has nothing
      // following it, so it never backtracks), which guarantees the run \s+ can
      // match below is at most one character, and by trimming the ends with a
      // character scan instead of an anchored regex. There is no \n inside a
      // line here — caveman() split on it above — so widening [ \t] to \s
      // cannot damage line structure.
      return trimHorizontal(
        out
          .replace(/\s{2,}/g, " ")
          .replace(/\s+([.,;:!?])/g, "$1")
          .replace(/([.,;:])\1+/g, "$1")
      );
    })
    .join("\n");
}

// Exported for the test suite, which asserts that no NEVER_DROP word can be
// removed by any level. That invariant is the whole safety argument for
// running a lossy pass on someone's prompt.
export const _internals = { DROPPABLE, NEVER_DROP, looksLikeCode };
