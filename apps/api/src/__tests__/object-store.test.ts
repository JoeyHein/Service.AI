import { describe, it, expect } from 'vitest';
import { stubObjectStore, storeDoorImage } from '../object-store.js';

describe('storeDoorImage (WI image capture)', () => {
  const store = stubObjectStore();

  it('returns null when no image is provided', async () => {
    expect(await storeDoorImage(store, 'k.png', undefined)).toBeNull();
  });

  it('stores a data-URL image and returns the key', async () => {
    const key = await storeDoorImage(
      store,
      'widget-leads/abc.png',
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(key).toBe('widget-leads/abc.png');
  });

  it('accepts a bare base64 string (no data-URL prefix)', async () => {
    const key = await storeDoorImage(store, 'widget-leads/def.png', 'iVBORw0KGgo=');
    expect(key).toBe('widget-leads/def.png');
  });

  it('returns null for an empty payload', async () => {
    expect(await storeDoorImage(store, 'k.png', '')).toBeNull();
  });
});
