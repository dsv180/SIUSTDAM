/**
 * LanguageSwitcher — переключатель языка (zh-CN / en-US / ru-RU)
 */
import { Dropdown, List } from 'tea-component';
import { InternetIcon } from 'tea-icons-react';
import { changeLanguage, getCurrentLanguage } from '@/i18n';
import './language-switcher.css';

const LANGS = [
  { code: 'zh-CN', label: 'Chinese' },
  { code: 'en-US', label: 'English' },
  { code: 'ru-RU', label: 'Русский' },
];

export function LanguageSwitcher() {
  const current = getCurrentLanguage();

  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <button type="button" className="_memory-lang-switcher-btn" title="Language">
          <InternetIcon size={16} />
          <span className="_memory-lang-switcher-label">
            {LANGS.find((l) => l.code === current)?.label ?? 'English'}
          </span>
        </button>
      }
    >
      {() => (
        <List type="option">
          {LANGS.map((l) => (
            <List.Item
              key={l.code}
              selected={current === l.code}
              onClick={() => { changeLanguage(l.code); }}
            >
              {l.label}
            </List.Item>
          ))}
        </List>
      )}
    </Dropdown>
  );
}
