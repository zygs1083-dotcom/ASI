import { Check, Copy } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Plugin } from 'unified';

// hast 里可继续下钻的块级容器 vs 直接承载文本的末尾块
const CURSOR_CONTAINERS = new Set(['blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr']);
const CURSOR_TEXT_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th']);

interface HastEl {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastEl[];
  properties?: { className?: unknown };
}

const lastElement = (node: HastEl): HastEl | null => {
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].type === 'element') return children[i];
  }
  return null;
};

// 末尾实质内容：元素节点返回元素，非空白文本返回 'text'，其余忽略
const lastRelevant = (node: HastEl): HastEl | 'text' | null => {
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (c.type === 'element') return c;
    if (c.type === 'text' && /\S/.test(c.value ?? '')) return 'text';
  }
  return null;
};

const blockCandidate = (el: HastEl): boolean => {
  const tag = el.tagName ?? '';
  return tag === 'pre' || CURSOR_TEXT_BLOCKS.has(tag) || CURSOR_CONTAINERS.has(tag);
};

const markTail = (el: HastEl): void => {
  if (!el.properties) el.properties = {};
  const cls = el.properties.className;
  el.properties.className = [...(Array.isArray(cls) ? cls : cls ? [cls] : []), 'stream-tail'];
};

// 沿最深的末尾元素下钻：块级容器继续走，文本块打标，pre 标到内部 code
// （自定义 CodeBlock 的 code 走默认渲染，className 会透传）。整个文档只标一处，
// CSS 只在该标记上画光标——保证任何结构下有且仅有一个光标。
const rehypeStreamTail: Plugin = () => (tree) => {
  const first = lastRelevant(tree as unknown as HastEl);
  if (!first || first === 'text') return;
  let el = first;
  for (;;) {
    const tag = el.tagName ?? '';
    if (tag === 'pre') {
      markTail(lastElement(el) ?? el);
      return;
    }
    if (CURSOR_TEXT_BLOCKS.has(tag)) {
      markTail(el);
      return;
    }
    if (!CURSOR_CONTAINERS.has(tag)) return; // hr 等：不标，交给容器兜底光标
    // 仅当末尾实质内容是块级才继续下钻；行内元素/文本结尾时容器本身就是最深文本块
    const next = lastRelevant(el);
    if (!next || next === 'text' || !blockCandidate(next)) {
      markTail(el);
      return;
    }
    el = next;
  }
};

function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const copy = async () => {
    const text = preRef.current?.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('fail');
    }
    setTimeout(() => setState('idle'), 1500);
  };

  return (
    <div className="md-code">
      <button type="button" className="md-copy" onClick={copy} aria-label="复制代码">
        {state === 'ok' ? (
          <Check size={13} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Copy size={13} strokeWidth={1.5} aria-hidden="true" />
        )}
        {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : '复制'}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md${streaming ? ' streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={streaming ? [rehypeStreamTail] : []}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          // 不加载外部图片：附件/图片超出范围，仅保留说明性文本
          img: ({ alt, src }) => <span className="md-img">[图片：{alt || src || '未命名'}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
