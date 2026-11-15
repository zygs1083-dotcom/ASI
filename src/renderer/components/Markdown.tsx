import { Check, Copy } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
