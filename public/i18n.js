const FORMAT = 'uai-interface-translation';
const VERSION = 1;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const MAX_ENTRIES = 5000;
const MAX_CONTRIBUTORS = 20;

function clean(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sourceHash(source) {
  let hash = 2166136261;
  for (const char of clean(source)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function validateTranslationPack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid-translation-pack');
  if (value.format !== FORMAT || value.version !== VERSION) throw new Error('unsupported-translation-pack');
  if (typeof value.locale !== 'string' || !LOCALE.test(value.locale))
    throw new Error('invalid-translation-locale');
  if (value.sourceLocale !== undefined && clean(value.sourceLocale).toLowerCase() !== 'en')
    throw new Error('invalid-translation-source-locale');
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES)
    throw new Error('invalid-translation-entries');
  const keys = new Set();
  const revision = Number(value.revision || 0);
  if (!Number.isInteger(revision) || revision < 0 || revision > 1_000_000)
    throw new Error('invalid-translation-revision');
  const contributors = validateContributors(value.contributors);
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('invalid-translation-entry');
    const key = clean(entry.key);
    const source = clean(entry.source);
    const translation = clean(entry.translation);
    if (!key || !source || key.length > 160 || source.length > 1000 || translation.length > 2000)
      throw new Error('invalid-translation-entry');
    if (keys.has(key)) throw new Error('duplicate-translation-key');
    keys.add(key);
    if (entry.sourceHash && entry.sourceHash !== sourceHash(source))
      throw new Error('outdated-translation-source');
    return {
      key,
      source,
      translation,
      location: clean(entry.location),
      context: clean(entry.context),
      maxLength: Number.isInteger(entry.maxLength) && entry.maxLength > 0 ? entry.maxLength : null,
      sourceHash: sourceHash(source),
    };
  });
  return {
    format: FORMAT,
    version: VERSION,
    locale: value.locale,
    language: clean(value.language) || value.locale,
    sourceLocale: 'en',
    appVersion: clean(value.appVersion),
    revision,
    contributors,
    entries,
  };
}

export function validateContributors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTRIBUTORS)
    throw new Error('invalid-translation-contributors');
  const names = new Set();
  return value.map((contributor) => {
    if (!contributor || typeof contributor !== 'object' || Array.isArray(contributor))
      throw new Error('invalid-translation-contributor');
    const anonymous = contributor.anonymous === true;
    const name = clean(contributor.name);
    if (anonymous && name) throw new Error('invalid-anonymous-translation-credit');
    if (!anonymous && (!name || name.length > 80)) throw new Error('invalid-translation-contributor');
    const normalized = name.toLocaleLowerCase();
    if (name && names.has(normalized)) throw new Error('duplicate-translation-contributor');
    if (name) names.add(normalized);
    return anonymous ? { anonymous: true } : { name };
  });
}

export function officialCreditNames(packOrDescriptor) {
  return (packOrDescriptor?.contributors || [])
    .filter((contributor) => contributor && contributor.anonymous !== true && contributor.name)
    .map((contributor) => contributor.name);
}

export function validateOfficialTranslationRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid-official-translation-registry');
  if (value.format !== 'uai-official-translations' || value.version !== 1)
    throw new Error('unsupported-official-translation-registry');
  if (!Array.isArray(value.languages) || value.languages.length > 200)
    throw new Error('invalid-official-translation-languages');
  const locales = new Set();
  const languages = value.languages.map((language) => {
    if (!language || typeof language !== 'object' || Array.isArray(language))
      throw new Error('invalid-official-translation-language');
    const locale = clean(language.locale);
    const name = clean(language.language);
    const file = clean(language.file);
    const revision = Number(language.revision || 0);
    if (!LOCALE.test(locale) || !name || name.length > 80 || !/^[a-z]{2,3}(?:-[A-Z]{2})?\.json$/.test(file))
      throw new Error('invalid-official-translation-language');
    if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000)
      throw new Error('invalid-official-translation-revision');
    if (locales.has(locale)) throw new Error('duplicate-official-translation-locale');
    locales.add(locale);
    return {
      locale,
      language: name,
      revision,
      file,
      contributors: validateContributors(language.contributors),
    };
  });
  return {
    format: 'uai-official-translations',
    version: 1,
    updatedAt: clean(value.updatedAt),
    languages,
  };
}

function locationFor(node) {
  const element = node.parentElement;
  const scope = element?.closest('[id], section, header, aside, dialog, nav, main');
  const label =
    scope?.getAttribute('aria-label') ||
    scope?.querySelector(':scope > h1, :scope > h2, :scope > h3')?.textContent ||
    scope?.id ||
    'Interface';
  return clean(label).slice(0, 140) || 'Interface';
}

function translationMeta(element) {
  if (element?.closest('.rail-tab'))
    return { location: 'Sidebar navigation', context: 'Short navigation label.', maxLength: 14 };
  if (element?.closest('button, .slash-button, .square-button'))
    return { location: locationFor(element), context: 'Action label. Keep concise.', maxLength: 28 };
  if (element?.matches('option') || element?.closest('select'))
    return { location: locationFor(element), context: 'Dropdown option.', maxLength: 32 };
  return { location: locationFor(element), context: '', maxLength: null };
}

function stableElementKey(element, kind) {
  const parts = [];
  let current = element;
  while (current && current !== document.body) {
    if (current.id) {
      parts.unshift(`#${current.id}`);
      break;
    }
    const tag = current.tagName?.toLowerCase() || 'node';
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
      : [];
    const index = Math.max(0, siblings.indexOf(current));
    parts.unshift(`${tag}[${index}]`);
    current = current.parentElement;
  }
  return `ui.${sourceHash(`${parts.join('>')}@${kind}`).slice(-8)}`;
}

function isTranslatableText(node) {
  const parent = node.parentElement;
  return (
    parent &&
    isTranslatableElement(parent) &&
    !parent.closest('[data-i18n-skip-content]') &&
    clean(node.nodeValue)
  );
}

function isTranslatableElement(element) {
  return !element.closest(
    [
      'script',
      'style',
      'code',
      'pre',
      'textarea',
      '[data-i18n-skip]',
      // These areas are populated from the catalog or a user's private data.
      // They need catalog localization, not an interface translation pack.
      '.title-card',
      '.detail-dialog',
      '.collection-dialog',
      '.franchise-card',
      '.collection-card',
      '.episode-tracker',
      '#masterGrid',
      '#westernGrid',
      '#adultGrid',
      '#kidsGrid',
      '#favoriteGrid',
      '#collectionGrid',
      '#collectionBody',
      '#franchiseStack',
      '#statStrip',
      '#favoriteCards',
      '#userListSummary',
      '#sourceList',
      '#backupSummary',
      '#backupPreview',
      '#correctionDraftList',
      '#correctionReviewResult',
    ].join(', '),
  );
}

export function createInterfaceI18n() {
  let pack = null;
  let bySource = new Map();
  let byKey = new Map();
  const observed = new Map();

  function observe(source, location, context = '', maxLength = null, explicitKey = '') {
    const text = clean(source);
    if (!text || text.length > 1000 || /^\d+(?:[.,/]\d+)*$/.test(text)) return;
    const key = explicitKey || `ui.${sourceHash(text).slice(-8)}`;
    const prior = observed.get(key);
    observed.set(key, {
      key,
      // A translated document can be scanned more than once. Keep the original
      // English source rather than accidentally exporting the translated wording.
      source: prior?.source || text,
      translation: prior?.translation || '',
      location: prior?.location || location || 'Interface',
      context: prior?.context || context,
      maxLength: prior?.maxLength || maxLength || null,
      sourceHash: sourceHash(prior?.source || text),
    });
  }

  function translate(source) {
    const text = clean(source);
    const entry = bySource.get(text);
    if (!entry?.translation || (entry.maxLength && entry.translation.length > entry.maxLength)) return null;
    return entry.translation;
  }

  function message(
    key,
    source,
    variables = {},
    { location = 'Interface', context = '', maxLength = null } = {},
  ) {
    observe(source, location, context, maxLength, key);
    const entry = byKey.get(key);
    const template =
      entry?.translation && (!entry.maxLength || entry.translation.length <= entry.maxLength)
        ? entry.translation
        : source;
    return template.replace(/\{([a-zA-Z][\w-]*)\}/g, (_, name) => String(variables[name] ?? `{${name}}`));
  }

  function apply(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (isTranslatableText(walker.currentNode)) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const source = clean(node.nodeValue);
      const meta = translationMeta(node.parentElement);
      observe(
        source,
        meta.location,
        meta.context,
        meta.maxLength,
        stableElementKey(node.parentElement, 'text'),
      );
      const translated = translate(source);
      if (translated) node.nodeValue = node.nodeValue.replace(source, translated);
    });
    const attributes = ['placeholder', 'aria-label', 'data-tooltip', 'title'];
    root.querySelectorAll?.('*').forEach((element) =>
      attributes.forEach((attribute) => {
        if (!isTranslatableElement(element)) return;
        const source = clean(element.getAttribute(attribute));
        if (!source) return;
        const meta = translationMeta(element);
        observe(
          source,
          meta.location,
          meta.context || `${attribute} text.`,
          meta.maxLength,
          stableElementKey(element, attribute),
        );
        const translated = translate(source);
        if (translated) element.setAttribute(attribute, translated);
      }),
    );
  }

  function setPack(nextPack) {
    pack = nextPack ? validateTranslationPack(nextPack) : null;
    bySource = new Map(
      (pack?.entries || []).filter((entry) => entry.translation).map((entry) => [entry.source, entry]),
    );
    byKey = new Map(
      (pack?.entries || []).filter((entry) => entry.translation).map((entry) => [entry.key, entry]),
    );
  }

  function template() {
    return {
      format: FORMAT,
      version: VERSION,
      locale: 'xx-XX',
      language: 'Language name',
      sourceLocale: 'en',
      appVersion: '',
      revision: 0,
      contributors: [],
      entries: [...observed.values()].sort(
        (a, b) => a.location.localeCompare(b.location) || a.source.localeCompare(b.source),
      ),
    };
  }

  function start() {
    apply(document);
    new MutationObserver((records) =>
      records.forEach((record) =>
        record.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) apply(node);
          else if (node.nodeType === Node.TEXT_NODE && isTranslatableText(node)) apply(node.parentElement);
        }),
      ),
    ).observe(document.body, { childList: true, subtree: true });
  }

  return {
    apply,
    message,
    setPack,
    start,
    template,
    get pack() {
      return pack;
    },
  };
}
