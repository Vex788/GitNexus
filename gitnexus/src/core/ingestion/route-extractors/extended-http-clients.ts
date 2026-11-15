import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import type { ExtractedFetchCall } from '../workers/parse-worker.js';

type SyntaxNode = Parser.SyntaxNode;

const DIRECT_HTTP_CALLEES = new Set(['fetch', 'ofetch', '$fetch', 'axios', 'ky']);

const CLIENT_ONLY_MEMBER_METHODS = new Set(['ajax', 'getJSON', 'request', 'head', 'options']);

const VERB_MEMBER_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

const SERVER_ROUTER_RECEIVERS = new Set([
  'app',
  'router',
  'server',
  'fastify',
  'hono',
  'express',
  'koa',
  'route',
  'blueprint',
  'bp',
]);

const KNOWN_CLIENT_RECEIVERS = new Set([
  '$',
  'jQuery',
  'axios',
  'ky',
  'got',
  'superagent',
  'requests',
  'httpx',
  'http',
  'httpClient',
  'api',
  'apiClient',
  'restClient',
  'serviceClient',
]);

function isHttpClientReceiver(rawReceiver: string): boolean {
  const cleaned = rawReceiver.replace(/^this\./, '').trim();
  if (!cleaned || SERVER_ROUTER_RECEIVERS.has(cleaned)) return false;
  if (KNOWN_CLIENT_RECEIVERS.has(cleaned)) return true;
  return /(?:Api|Client|Http|Axios|Fetcher|Session)$/.test(cleaned);
}

function unquoteStringNode(node: SyntaxNode): string | null {
  const text = node.text;
  if (text.length < 2) return null;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    return text.slice(1, -1);
  }
  // Python f-string / raw string: f"/v1/items/{item_id}"
  const pyMatch = text.match(/^[fFrRbBuU]{1,2}(["'])(.*)\1$/s);
  if (pyMatch) {
    // Convert Python f-string `{expr}` interpolations to `${expr}` for normalizeFetchURL
    return pyMatch[2].replace(/\{([^{}]+)\}/g, '${$1}');
  }
  return null;
}

function isLikelyUrlConstantValue(val: string): boolean {
  return (
    val.startsWith('/') ||
    val.startsWith('./') ||
    /\.(?:xhtml|action)(?:[?!#]|$)/i.test(val)
  );
}

function collectLocalUrlConstants(
  rootNode: SyntaxNode,
  language: SupportedLanguages,
): Map<string, string> {
  const out = new Map<string, string>();
  const record = (name: string | undefined, valNode: SyntaxNode | null | undefined) => {
    if (!name || !valNode) return;
    if (
      valNode.type === 'string' ||
      valNode.type === 'string_literal' ||
      valNode.type === 'template_string'
    ) {
      if (valNode.type === 'template_string' && valNode.text.includes('${')) return;
      const unq = unquoteStringNode(valNode);
      if (unq && isLikelyUrlConstantValue(unq)) {
        if (!out.has(name)) out.set(name, unq);
      }
    }
  };

  for (const stmt of rootNode.namedChildren) {
    if (language === SupportedLanguages.Python) {
      const assign =
        stmt.type === 'expression_statement' ? stmt.firstNamedChild : stmt;
      if (assign?.type === 'assignment') {
        const left = assign.childForFieldName('left');
        const right = assign.childForFieldName('right');
        if (left?.type === 'identifier') record(left.text, right);
      }
      continue;
    }

    const decl =
      stmt.type === 'export_statement'
        ? stmt.namedChildren.find(
            (c) => c.type === 'lexical_declaration' || c.type === 'variable_declaration',
          )
        : stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration'
          ? stmt
          : null;
    if (!decl) continue;
    const isConst = decl.text.trimStart().startsWith('const ');
    if (!isConst) continue;
    for (const declarator of decl.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const nameNode = declarator.childForFieldName('name');
      const valNode = declarator.childForFieldName('value');
      if (nameNode?.type === 'identifier') {
        record(nameNode.text, valNode);
      }
    }
  }
  return out;
}

function isEnvOrGatewayExpr(node: SyntaxNode): boolean {
  const t = node.text.trim();
  if (
    t.startsWith('import.meta.env.') ||
    t.startsWith('process.env.') ||
    t.startsWith('window.') ||
    t === 'contextPath' ||
    t === 'BASE_URL' ||
    t === 'API_URL' ||
    t === 'API_BASE_URL'
  ) {
    return true;
  }
  if (node.type === 'identifier' && /(?:_URL|_HOST|_ORIGIN|_BASE|BaseUrl|ApiUrl)$/.test(t)) {
    return true;
  }
  return false;
}

function evalUrlExpression(
  node: SyntaxNode | null | undefined,
  localConsts: ReadonlyMap<string, string>,
  depth = 0,
): string | null {
  if (!node || depth > 5) return null;

  if (node.type === 'parenthesized_expression') {
    return evalUrlExpression(node.firstNamedChild, localConsts, depth + 1);
  }

  if (node.type === 'identifier') {
    return localConsts.get(node.text) ?? null;
  }

  if (node.type === 'string' || node.type === 'string_literal') {
    return unquoteStringNode(node);
  }

  if (node.type === 'template_string') {
    const raw = unquoteStringNode(node);
    if (raw === null) return null;
    return raw.replace(/\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g, (full, ident: string) =>
      localConsts.get(ident) ?? full,
    );
  }

  if (node.type === 'binary_expression' || node.type === 'binary_operator') {
    const op = node.childForFieldName('operator')?.text ?? '+';
    if (op !== '+') return null;
    const left = node.childForFieldName('left') ?? node.namedChildren[0];
    const right = node.childForFieldName('right') ?? node.namedChildren[1];
    if (!left || !right) return null;

    const leftVal = evalUrlExpression(left, localConsts, depth + 1);
    const rightVal = evalUrlExpression(right, localConsts, depth + 1);

    if (leftVal !== null && rightVal !== null) {
      return `${leftVal}${rightVal}`;
    }
    // `ENV_BASE_URL + '/api/orders'` -> `${env}/api/orders`
    if (leftVal === null && isEnvOrGatewayExpr(left) && rightVal !== null) {
      return rightVal.startsWith('/') ? `\${base}${rightVal}` : null;
    }
    // `'/api/orders/' + orderId` or `'./pickpack.xhtml?ev&k=' + encodeURIComponent(v)`
    if (leftVal !== null && rightVal === null) {
      if (leftVal.endsWith('/') || leftVal.endsWith('=') || leftVal.includes('?')) {
        return `${leftVal}\${param}`;
      }
    }
    return null;
  }

  return null;
}

function extractUrlFromConfigObject(
  objNode: SyntaxNode | null | undefined,
  localConsts: ReadonlyMap<string, string>,
): string | null {
  if (!objNode || objNode.type !== 'object') return null;
  for (const child of objNode.namedChildren) {
    if (child.type !== 'pair') continue;
    const keyNode = child.childForFieldName('key');
    if (!keyNode) continue;
    const key = keyNode.text.replace(/^['"]|['"]$/g, '');
    if (key === 'url') {
      return evalUrlExpression(child.childForFieldName('value'), localConsts);
    }
  }
  return null;
}

function joinBaseAndPath(baseUrl: string, subPath: string): string {
  if (!baseUrl) return subPath;
  if (subPath.startsWith('http://') || subPath.startsWith('https://')) return subPath;
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanSub = subPath.replace(/^\/+/, '');
  return cleanSub ? `${cleanBase}/${cleanSub}` : cleanBase || '/';
}

function extractRtkQueryCalls(
  callNode: SyntaxNode,
  filePath: string,
  lineOffset: number,
  localConsts: ReadonlyMap<string, string>,
  requestEnclosingId: (node: SyntaxNode | null | undefined) => string | undefined,
  out: ExtractedFetchCall[],
): void {
  const args = callNode.childForFieldName('arguments');
  const configObj = args?.namedChildren.find((c) => c.type === 'object');
  if (!configObj) return;

  let baseUrl = '';
  let endpointsNode: SyntaxNode | null = null;
  for (const pair of configObj.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '');
    const val = pair.childForFieldName('value');
    if (key === 'baseQuery' && val?.type === 'call_expression') {
      const bqArgs = val.childForFieldName('arguments');
      const bqObj = bqArgs?.namedChildren.find((c) => c.type === 'object');
      if (bqObj) {
        for (const bp of bqObj.namedChildren) {
          if (bp.type !== 'pair') continue;
          const bk = bp.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '');
          if (bk === 'baseUrl') {
            baseUrl = evalUrlExpression(bp.childForFieldName('value'), localConsts) ?? '';
          }
        }
      }
    } else if (key === 'endpoints' && val) {
      endpointsNode = val;
    }
  }
  if (!endpointsNode) return;

  const visit = (n: SyntaxNode): void => {
    if (n.type === 'pair') {
      const k = n.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '');
      const v = n.childForFieldName('value');
      if (k === 'query' && v && (v.type === 'arrow_function' || v.type === 'function_expression')) {
        const body = v.childForFieldName('body');
        let targetExpr: SyntaxNode | null = body;
        if (body?.type === 'parenthesized_expression') targetExpr = body.firstNamedChild;
        else if (body?.type === 'statement_block') {
          const ret = body.namedChildren.find((c) => c.type === 'return_statement');
          targetExpr = ret?.firstNamedChild ?? null;
        }
        const rawUrl =
          targetExpr?.type === 'object'
            ? extractUrlFromConfigObject(targetExpr, localConsts)
            : evalUrlExpression(targetExpr, localConsts);
        if (rawUrl) {
          out.push({
            filePath,
            fetchURL: joinBaseAndPath(baseUrl, rawUrl),
            lineNumber: n.startPosition.row + lineOffset,
            enclosingId: requestEnclosingId(n),
          });
        }
        return;
      }
    }
    for (const child of n.namedChildren) visit(child);
  };
  visit(endpointsNode);
}

/**
 * Extract HTTP client calls not covered by single-literal tree-sitter rules:
 * - `axios.{get,post,put,delete,patch,request}(...)` & `axios({ url: ... })`
 * - jQuery `$.ajax({ url: ... })`, `$.get(...)`, `$.post(...)`, `$.getJSON(...)`
 * - `ky`, `ofetch`, `$fetch`, Angular `this.http.get(...)`, Python `requests`/`httpx`
 * - Template strings & `+`-concatenations referencing module `const` URL prefixes
 * - RTK Query `createApi({ baseQuery: fetchBaseQuery({ baseUrl }), endpoints })`
 */
export function extractExtendedHttpClientCalls(
  rootNode: SyntaxNode,
  filePath: string,
  language: SupportedLanguages,
  lineOffset: number,
  requestEnclosingId: (node: SyntaxNode | null | undefined) => string | undefined,
): ExtractedFetchCall[] {
  const localConsts = collectLocalUrlConstants(rootNode, language);
  const out: ExtractedFetchCall[] = [];

  const stack: SyntaxNode[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'call_expression' || node.type === 'call') {
      const fnNode = node.childForFieldName('function');
      const argsNode = node.childForFieldName('arguments');
      const firstArg = argsNode?.namedChildren[0] ?? null;

      if (fnNode && firstArg) {
        if (fnNode.type === 'identifier') {
          const fnName = fnNode.text;
          if (fnName === 'createApi') {
            extractRtkQueryCalls(node, filePath, lineOffset, localConsts, requestEnclosingId, out);
          } else if (DIRECT_HTTP_CALLEES.has(fnName)) {
            const url =
              firstArg.type === 'object'
                ? extractUrlFromConfigObject(firstArg, localConsts)
                : evalUrlExpression(firstArg, localConsts);
            if (url) {
              out.push({
                filePath,
                fetchURL: url,
                lineNumber: node.startPosition.row + lineOffset,
                enclosingId: requestEnclosingId(node),
              });
            }
          }
        } else if (fnNode.type === 'member_expression' || fnNode.type === 'attribute') {
          const objNode = fnNode.childForFieldName('object');
          const propNode =
            fnNode.childForFieldName('property') ?? fnNode.childForFieldName('attribute');
          const method = propNode?.text ?? '';
          const receiver = objNode?.text ?? '';

          const isClientOnly = CLIENT_ONLY_MEMBER_METHODS.has(method);
          const isClientVerb = VERB_MEMBER_METHODS.has(method) && isHttpClientReceiver(receiver);

          if (isClientOnly || isClientVerb) {
            // Python keyword arg `url="..."` fallback
            let resolvedUrl =
              firstArg.type === 'object'
                ? extractUrlFromConfigObject(firstArg, localConsts)
                : evalUrlExpression(firstArg, localConsts);
            if (!resolvedUrl && argsNode) {
              for (const arg of argsNode.namedChildren) {
                if (arg.type === 'keyword_argument') {
                  const k = arg.childForFieldName('name')?.text;
                  if (k === 'url') {
                    resolvedUrl = evalUrlExpression(arg.childForFieldName('value'), localConsts);
                    break;
                  }
                } else if (arg.type === 'object') {
                  resolvedUrl = extractUrlFromConfigObject(arg, localConsts);
                  if (resolvedUrl) break;
                }
              }
            }
            if (resolvedUrl) {
              out.push({
                filePath,
                fetchURL: resolvedUrl,
                lineNumber: node.startPosition.row + lineOffset,
                enclosingId: requestEnclosingId(node),
              });
            }
          }
        }
      }
    }

    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }

  return out;
}
