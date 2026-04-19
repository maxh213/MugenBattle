-- Market listings: sellers set a per-fighter asking price when moving a
-- bench fighter to slot='for_sale'. NULL while not listed. Used in Phase B
-- (user-to-user trades); already part of the schema so Phase A endpoints
-- that read for_sale rows don't need a rebind.

ALTER TABLE owned_fighter ADD COLUMN listing_price_cents INTEGER;
