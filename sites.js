// Single source of truth for the supported providers.
//
// Loaded by content.js (needs `composer` selectors and `gate`) and by
// composer.html (needs `label` and `base`). Keep it free of DOM access so both
// contexts can evaluate it.
//
// Keys are bare hostnames; content.js resolves www. aliases against them.
//   label    - shown in the composer page's provider picker
//   base     - URL the composer page opens before appending ?prompt=
//   gate     - path prefix, when the manifest match is broader than the chat page
//   composer - ordered selectors, most specific first
(() => {
  globalThis.LLM_SITES = {
    'chatgpt.com': {
      label: 'ChatGPT',
      base: 'https://chatgpt.com/',
      composer: ['#prompt-textarea', 'main textarea', 'form textarea', 'textarea'],
    },
    'claude.ai': {
      label: 'Claude',
      base: 'https://claude.ai/new',
      composer: ['div[contenteditable="true"]', '.ProseMirror', 'textarea'],
    },
    'gemini.google.com': {
      label: 'Gemini',
      base: 'https://gemini.google.com/app',
      composer: [
        'input-area-v2 div.single-line-format > div',
        'input-area-v2 div[class*="single-line-format"] > div',
        'input-area-v2 [contenteditable="true"]',
        'chat-window input-area-v2 [contenteditable="true"]',
        '#xap-skip-link-target chat-window input-area-v2 div.single-line-format > div',
        'div[contenteditable="true"]', 'rich-textarea', 'textarea',
      ],
    },
    'grok.com': { label: 'Grok', base: 'https://grok.com/' },
    'perplexity.ai': {
      label: 'Perplexity',
      base: 'https://perplexity.ai/',
      composer: [
        '#ask-input',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        '#root [contenteditable="true"]',
        '#root textarea',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea',
      ],
    },
    'meta.ai': {
      label: 'Meta AI',
      base: 'https://meta.ai/',
      composer: ['div[data-testid="composer-input"][contenteditable="true"]'],
    },
    'chat.deepseek.com': { label: 'DeepSeek', base: 'https://chat.deepseek.com/' },
    'chat.qwen.ai': { label: 'Qwen', base: 'https://chat.qwen.ai/' },
    'kimi.ai': { label: 'Kimi', base: 'https://www.kimi.ai/' },
    'manus.im': { label: 'Manus', base: 'https://manus.im/' },
    'poe.com': { label: 'Poe', base: 'https://poe.com/' },
    'chat.z.ai': { label: 'Z.AI', base: 'https://chat.z.ai/' },
    'pi.ai': { label: 'Pi', base: 'https://pi.ai/' },
    'duck.ai': { label: 'DuckDuckGo AI', base: 'https://duck.ai/' },
    'venice.ai': { label: 'Venice', base: 'https://venice.ai/' },
    'openrouter.ai': {
      label: 'OpenRouter',
      base: 'https://openrouter.ai/chat',
      gate: '/chat',
    },
    't3.chat': { label: 'T3 Chat', base: 'https://t3.chat/' },
    'genspark.ai': {
      label: 'Genspark',
      base: 'https://genspark.ai/',
      composer: [
        'div.textarea-wrapper textarea',
        '.search-input-and-toggle textarea',
        'div.textarea-wrapper [contenteditable="true"]',
        '#__nuxt textarea',
        'textarea',
      ],
    },
  };
})();
