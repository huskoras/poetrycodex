"""Languages, writing direction and search words, shared by the build tools.

app.js has the same three things (LANG_CODES, RTL_RE / dirAttr, and searchTokens / termKey in
"the search index"): change both together. tools/build_lists.py checks the two tokenisers
agree when it is run with --check-js (it needs Node).

1. lang_code("Classical Chinese") -> "lzh": the BCP 47 tag of a poem's `language` field
   (AGENTS.md rule 3d: "ISO name, e.g. French, Classical Chinese"); a field that is already a
   tag ("fr", "zh-Hant") is kept. Unknown names give "".
2. needs_dir_auto(lang, text): a right-to-left language (Arabic, Persian, Urdu, Hebrew,
   Yiddish, Syriac, Ottoman Turkish) or any Arabic / Hebrew / Syriac / Thaana letter in the
   text: the page then says dir="auto", and the browser sets the line from its first strong
   letter (so a Latin transliteration of Ottoman stays left to right).
3. search_tokens(text) / query_tokens(text): the words the static search index files a text
   under. Case, accents and the Latin special letters fold as `fold` in app.js does ("hasim"
   finds Haşim, "caedmon" Cædmon); Arabic and Persian lose their vowel signs and tatweel and
   share one alef, yeh, kaf and heh; Hebrew loses its points and its final letter forms; Greek
   loses accents and the final sigma; Cyrillic folds ё to е. Chinese, Japanese kana, Thai, Lao,
   Khmer and Burmese are written without spaces between words: there every character and every
   pair of neighbouring characters is a search word (a search for one character finds it; a
   longer search must match each of its pairs).
"""
import re
import unicodedata

LANG_CODES = {
    "english": "en", "old english": "ang", "anglo-saxon": "ang", "middle english": "enm", "scots": "sco",
    "middle scots": "sco", "latin": "la", "medieval latin": "la", "neo-latin": "la", "greek": "el",
    "modern greek": "el", "ancient greek": "grc", "classical greek": "grc", "homeric greek": "grc",
    "byzantine greek": "grc", "french": "fr", "old french": "fro", "middle french": "frm", "occitan": "oc",
    "provençal": "oc", "provencal": "oc", "old occitan": "pro", "german": "de", "middle high german": "gmh",
    "old high german": "goh", "low german": "nds", "old norse": "non", "icelandic": "is", "danish": "da",
    "swedish": "sv", "norwegian": "no", "faroese": "fo", "dutch": "nl", "middle dutch": "dum", "flemish": "nl",
    "frisian": "fy", "afrikaans": "af", "italian": "it", "sicilian": "scn", "spanish": "es", "castilian": "es",
    "old spanish": "osp", "portuguese": "pt", "galician": "gl", "galician-portuguese": "roa", "catalan": "ca",
    "romanian": "ro", "russian": "ru", "ukrainian": "uk", "belarusian": "be", "polish": "pl", "czech": "cs",
    "slovak": "sk", "serbian": "sr", "croatian": "hr", "serbo-croatian": "sh", "bosnian": "bs", "slovene": "sl",
    "slovenian": "sl", "bulgarian": "bg", "macedonian": "mk", "old church slavonic": "cu",
    "church slavonic": "cu", "hungarian": "hu", "finnish": "fi", "estonian": "et", "latvian": "lv",
    "lithuanian": "lt", "welsh": "cy", "middle welsh": "wlm", "irish": "ga", "old irish": "sga",
    "scottish gaelic": "gd", "gaelic": "gd", "breton": "br", "cornish": "kw", "manx": "gv", "turkish": "tr",
    "ottoman turkish": "ota", "ottoman": "ota", "azerbaijani": "az", "chagatai": "chg", "arabic": "ar",
    "classical arabic": "ar", "persian": "fa", "classical persian": "fa", "farsi": "fa", "urdu": "ur",
    "pashto": "ps", "kurdish": "ku", "hebrew": "he", "biblical hebrew": "hbo", "medieval hebrew": "he",
    "yiddish": "yi", "ladino": "lad", "aramaic": "arc", "syriac": "syr", "sanskrit": "sa", "prakrit": "pra",
    "pali": "pi", "hindi": "hi", "braj": "bra", "awadhi": "awa", "bengali": "bn", "punjabi": "pa",
    "marathi": "mr", "gujarati": "gu", "tamil": "ta", "telugu": "te", "kannada": "kn", "malayalam": "ml",
    "chinese": "zh", "classical chinese": "lzh", "literary chinese": "lzh", "mandarin": "zh",
    "japanese": "ja", "classical japanese": "ja", "korean": "ko", "vietnamese": "vi", "tibetan": "bo",
    "mongolian": "mn", "thai": "th", "lao": "lo", "khmer": "km", "burmese": "my", "malay": "ms",
    "javanese": "jv", "armenian": "hy", "classical armenian": "xcl", "georgian": "ka", "akkadian": "akk",
    "sumerian": "sux", "egyptian": "egy", "coptic": "cop", "ge'ez": "gez", "amharic": "am", "swahili": "sw",
    "esperanto": "eo", "basque": "eu", "albanian": "sq", "maltese": "mt", "nahuatl": "nah", "quechua": "qu",
    "hawaiian": "haw", "maori": "mi", "māori": "mi",
}
RTL_LANGS = {"ar", "fa", "ur", "ps", "ku", "he", "hbo", "yi", "lad", "arc", "syr", "ota", "chg"}
RTL_CHARS = re.compile("[֐-ࣿיִ-﷿ﹰ-ﻼ]")
TAG = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


def lang_code(language):
    s = str(language or "").strip()
    if not s:
        return ""
    if TAG.match(s):
        return s
    return LANG_CODES.get(s.lower(), "")


def needs_dir_auto(lang, text=""):
    return lang.split("-")[0] in RTL_LANGS or bool(RTL_CHARS.search(text or ""))


# ---- search words (app.js: searchTokens, the same rules) ----
# Removed outright: combining accents (Latin, Greek, Cyrillic), Hebrew points and cantillation
# (not the maqaf or sof pasuq, which part words), Arabic vowel signs and Quranic marks, tatweel,
# zero-width joiners, soft hyphen, apostrophes and the Hebrew geresh / gershayim.
STRIP = re.compile("[̀-֑ͯ-ׇֽֿׁׂׅׄؐ-ؚ"
                   "ً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭـ"
                   "​-‍­'‘’ʼʾʿ`׳״]")
LETTERS = {"æ": "ae", "œ": "oe", "þ": "th", "ð": "d", "ø": "o", "ł": "l", "ß": "ss", "ı": "i", "đ": "d",
           "ƿ": "w", "ς": "σ", "ٱ": "ا", "ي": "ی", "ى": "ی", "ك": "ک", "ة": "ه", "ە": "ه",
           "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"}
LETTER_RE = re.compile("[" + "".join(LETTERS) + "]")
MAX_TOKEN = 32


def bigram_char(cp):
    """Scripts written without spaces between words: Han, kana, Thai, Lao, Khmer, Burmese."""
    return (0x3400 <= cp <= 0x4DBF or 0x4E00 <= cp <= 0x9FFF or 0xF900 <= cp <= 0xFAFF
            or 0x20000 <= cp <= 0x3134F or 0x3040 <= cp <= 0x30FF or 0x31F0 <= cp <= 0x31FF
            or 0x3005 <= cp <= 0x3007 or 0x0E00 <= cp <= 0x0EFF or 0x1780 <= cp <= 0x17FF
            or 0x1000 <= cp <= 0x109F)


def normalize(s):
    s = unicodedata.normalize("NFKD", str(s or "").lower())
    s = STRIP.sub("", s)
    s = LETTER_RE.sub(lambda m: LETTERS[m.group(0)], s)
    return unicodedata.normalize("NFC", s)


def _runs(s):
    """(kind, text) runs of a normalised string: kind "w" a word, "b" a bigram-script run."""
    out, cur, kind = [], [], None
    for ch in s:
        cp = ord(ch)
        k = "b" if bigram_char(cp) else ("w" if unicodedata.category(ch)[0] in "LNM" else None)
        if k != kind and cur:
            out.append((kind, "".join(cur)))
            cur = []
        kind = k
        if k:
            cur.append(ch)
    if cur and kind:
        out.append((kind, "".join(cur)))
    return out


def search_tokens(text):
    """Every search word a text is filed under (a set)."""
    out = set()
    for kind, run in _runs(normalize(text)):
        if kind == "w":
            out.add(run[:MAX_TOKEN])
        else:
            out.update(run)
            out.update(run[i:i + 2] for i in range(len(run) - 1))
    return out


def query_tokens(text):
    """The words of a search, in order: a word, a lone character, or each pair of characters."""
    out = []
    for kind, run in _runs(normalize(text)):
        if kind == "w":
            out.append(run[:MAX_TOKEN])
        elif len(run) == 1:
            out.append(run)
        else:
            out.extend(run[i:i + 2] for i in range(len(run) - 1))
    return out


def key_char(ch):
    return ch if ("a" <= ch <= "z" or "0" <= ch <= "9") else "-%05x" % ord(ch)


def term_key(term, depth):
    """The file a word is kept in: its first `depth` letters (bigram scripts: one of 256
    buckets by the first character). app.js termKey()."""
    if bigram_char(ord(term[0])):
        return "x%02x" % (ord(term[0]) % 256)
    return "".join(key_char(c) for c in term[:depth])
