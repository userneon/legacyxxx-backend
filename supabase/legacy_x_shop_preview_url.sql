-- Goods (owner request 2026-11-07): the card shows the AI picture (image_url); the preview (the order window) shows the real photo (preview_url), when there is one.
ALTER TABLE legacy_x.shop_products ADD COLUMN IF NOT EXISTS preview_url text CHECK (preview_url IS NULL OR preview_url ~ '^https://');
