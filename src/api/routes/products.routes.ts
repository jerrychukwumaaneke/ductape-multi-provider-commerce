import { Router, Response, NextFunction } from 'express';
import { InventoryService } from '../../modules/inventory/inventory.service.js';
import { AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.js';
import { ValidationError } from '../../common/errors/app-error.js';
import { IdentityService } from '../../modules/identity/identity.service.js';

export function createProductsRouter(
  inventoryService: InventoryService,
  identityService: IdentityService
): Router {
  const router = Router();
  const auth = createAuthMiddleware(identityService);

  router.get('/products', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Number(req.query.limit) || 20;
      const offset = Number(req.query.offset) || 0;
      const query = typeof req.query.q === 'string' ? req.query.q : undefined;

      const products = await inventoryService.listProducts({ query, limit, offset });
      res.json({
        products,
        limit,
        offset,
        count: products.length,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/products/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const product = await inventoryService.getProduct(req.params.id as string);
      const inventory = await inventoryService.getInventory(req.params.id as string).catch(() => null);
      res.json({ product, inventory });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/products',
    auth.authenticate,
    auth.requireRole('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { sku, name, price_minor, currency, initial_stock } = req.body;
        if (!sku || !name || price_minor === undefined || !currency) {
          throw new ValidationError('sku, name, price_minor, and currency are required');
        }

        const created = await inventoryService.createProduct({
          sku,
          name,
          price_minor: Number(price_minor),
          currency,
          initial_stock: initial_stock !== undefined ? Number(initial_stock) : 0,
        });

        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    }
  );

  router.put(
    '/inventory/:productId',
    auth.authenticate,
    auth.requireRole('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { on_hand } = req.body;
        if (on_hand === undefined || Number(on_hand) < 0) {
          throw new ValidationError('on_hand must be an integer >= 0');
        }

        const inv = await inventoryService.setStock(req.params.productId as string, Number(on_hand));
        res.json(inv);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
