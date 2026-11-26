/**
 * Parses GitHub release notes Markdown into clean, readable sections and bullet items.
 *
 * Removes noisy commit-hash links like `([abc1234](https://.../commit/...))`, markdown images,
 * horizontal rules, code fences, and git trailers (`Signed-off-by`, `Co-authored-by`).
 */

export type ChangelogSectionKind =
  | 'features'
  | 'fixes'
  | 'improvements'
  | 'performance'
  | 'other';

export interface ParsedChangelogItem {
  scope?: string;
  text: string;
  isBullet: boolean;
}

export interface ParsedChangelogSection {
  kind: ChangelogSectionKind;
  title: string;
  items: ParsedChangelogItem[];
}

const COMMIT_LINK_RE = /\s*\(\[([0-9a-f]{7,40})\]\([^)]+\/commit\/[^)]+\)\)/gi;
const BARE_COMMIT_PARENS_RE = /\s*\([0-9a-f]{7,40}\)\s*$/i;
const SECTION_HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*$/;
const HEADING_DECORATION_RE = /^[^\p{L}\p{N}]+/u;
const LIST_ITEM_RE = /^\s*(?:[*+-]|\d+[.)])\s+(.+?)\s*$/;
const NOISE_LINE_RE =
  /^\s*(?:[-=_*~]{3,}|[<=>]{7}.*|```.*|<[^>]+>|(?:signed-off-by|co-authored-by):.*)\s*$/i;
const QUOTE_PREFIX_RE = /^\s*>\s?/;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const SCOPED_BODY_RE = /^\*\*([^*]+?):\*\*\s*(.*)$/;
const INLINE_BOLD_RE = /\*\*([^*]+)\*\*/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const FULL_CHANGELOG_LINE_RE =
  /^\*{0,2}\s*(?:full\s+changelog|changelog\s+completo)\s*:?\s*\*{0,2}\s*:?\s*https?:\/\//i;

function classifyHeading(rawHeading: string): { kind: ChangelogSectionKind; label: string } {
  const cleaned = rawHeading
    .replace(HEADING_DECORATION_RE, '')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(INLINE_BOLD_RE, '$1')
    .trim();
  const lower = cleaned.toLowerCase();

  if (/(?:feat|novidade|new|recurso|adicionad|what'?s changed)/i.test(lower)) {
    return { kind: 'features', label: 'Novidades' };
  }
  if (/(?:fix|corre[cç]|bug)/i.test(lower)) {
    return { kind: 'fixes', label: 'Correções' };
  }
  if (/(?:perf|desempenho|velocidade|otimiza)/i.test(lower)) {
    return { kind: 'performance', label: 'Desempenho' };
  }
  if (/(?:improv|melhoria|altera[cç]|change|refactor|update|atualiza)/i.test(lower)) {
    return { kind: 'improvements', label: 'Melhorias' };
  }
  return { kind: 'other', label: cleaned || 'Alterações' };
}

function cleanInlineMarkdown(raw: string): string {
  return raw
    .replace(IMAGE_RE, '')
    .replace(COMMIT_LINK_RE, '')
    .replace(BARE_COMMIT_PARENS_RE, '')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(INLINE_BOLD_RE, '$1')
    .replace(INLINE_CODE_RE, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseReleaseChangelog(markdown: string | null | undefined): ParsedChangelogSection[] {
  if (!markdown || !markdown.trim()) return [];

  const sections: ParsedChangelogSection[] = [];
  let current: ParsedChangelogSection | null = null;
  let inCodeFence = false;

  const ensureSection = (kind: ChangelogSectionKind = 'other', title = 'Alterações') => {
    if (!current) {
      current = { kind, title, items: [] };
      sections.push(current);
    }
    return current;
  };

  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || !trimmed) continue;
    if (NOISE_LINE_RE.test(trimmed)) continue;
    if (FULL_CHANGELOG_LINE_RE.test(trimmed)) continue;

    // Skip release version header lines like "# v1.2.0 (2026-11-26)" or "## Anisync v1.2"
    const headingMatch = trimmed.match(SECTION_HEADING_RE);
    if (headingMatch?.[1]) {
      const rawTitle = headingMatch[1].trim();
      if (/^(?:anisync\s+)?\[?v?\d+\.\d+/i.test(rawTitle) || /\(\d{4}-\d{2}-\d{2}\)\s*$/.test(rawTitle)) {
        continue;
      }
      const { kind, label } = classifyHeading(rawTitle);
      const existing = sections.find((s) => s.title.toLowerCase() === label.toLowerCase());
      if (existing) {
        current = existing;
      } else {
        current = { kind, title: label, items: [] };
        sections.push(current);
      }
      continue;
    }

    const unquoted = trimmed.replace(QUOTE_PREFIX_RE, '').trim();
    if (!unquoted) continue;

    const bulletMatch = unquoted.match(LIST_ITEM_RE);
    if (bulletMatch?.[1]) {
      const bodyRaw = bulletMatch[1].trim();
      // Drop pure build-SHA bookkeeping bullets (commit SHA is already shown in the metadata row)
      if (/^(?:commit|sha|build)\s*[:=-]\s*`?[0-9a-f]{7,40}`?$/i.test(bodyRaw)) continue;

      const scopedMatch = bodyRaw.match(SCOPED_BODY_RE);
      if (scopedMatch?.[1]) {
        const scope = cleanInlineMarkdown(scopedMatch[1]);
        const text = cleanInlineMarkdown(scopedMatch[2] || '');
        if (text) {
          ensureSection().items.push({ scope: scope || undefined, text, isBullet: true });
        }
      } else {
        const text = cleanInlineMarkdown(bodyRaw);
        if (text) {
          ensureSection().items.push({ text, isBullet: true });
        }
      }
      continue;
    }

    // Standalone prose line (skip raw SHA/build metadata lines already rendered in header)
    if (/^(?:commit|sha|build|tag)\s*[:=-]\s*`?[0-9a-f]{7,40}`?$/i.test(unquoted)) continue;
    const text = cleanInlineMarkdown(unquoted);
    if (text) {
      ensureSection().items.push({ text, isBullet: false });
    }
  }

  return sections.filter((section) => section.items.length > 0);
}
