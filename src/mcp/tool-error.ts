/** MCP ツールのエラー応答を組み立てる（data-model.md §4.1）。 */

function nonBlank(s: string): boolean {
  return s.trim() !== '';
}

/** 原因を示す空でないメッセージを返す。 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (nonBlank(e.message)) return e.message;
    if (nonBlank(e.name)) return e.name;
  } else if (typeof e === 'string') {
    if (nonBlank(e)) return e;
  } else if (e === null) {
    return 'unknown error (null)';
  } else if (e === undefined) {
    return 'unknown error (undefined)';
  } else if (typeof e === 'object') {
    try {
      const json: string | undefined = JSON.stringify(e);
      if (json !== undefined && nonBlank(json)) return json;
    } catch {
      // 循環参照・toJSON の例外などは toString にフォールバックする
    }
    return Object.prototype.toString.call(e);
  }
  let text = '';
  try {
    text = String(e);
  } catch {
    // 変換できない値は 'unknown error' にする
  }
  return nonBlank(text) ? text : 'unknown error';
}

export interface ToolErrorResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/**
 * `<prefix>: <errorMessage(e)>` を 1 つの text にした MCP エラー応答を返し、
 * 詳細（Error ならスタック、それ以外なら値）を console.error('[aegis] <prefix>:', e) で標準エラー出力に残す。
 */
export function toolErrorResult(prefix: string, e: unknown): ToolErrorResult {
  console.error(`[aegis] ${prefix}:`, e);
  return {
    content: [{ type: 'text', text: `${prefix}: ${errorMessage(e)}` }],
    isError: true,
  };
}
