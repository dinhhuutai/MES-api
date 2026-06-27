'use strict';

const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { ok } = require('./utils/response');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

const authRoutes = require('./modules/auth/auth.routes');
const usersRoutes = require('./modules/users/users.routes');
const rolesRoutes = require('./modules/roles/roles.routes');
const permissionsRoutes = require('./modules/permissions/permissions.routes');
const catalogRoutes = require('./modules/catalog/catalog.routes');
const appmoduleRoutes = require('./modules/appmodule/appmodule.routes');
const ordersRoutes = require('./modules/orders/orders.routes');
const technicalRoutes = require('./modules/technical/technical.routes');
const planningRoutes = require('./modules/planning/planning.routes');
const productionRoutes = require('./modules/production/production.routes');
const qualityRoutes = require('./modules/quality/quality.routes');
const deliveryRoutes = require('./modules/delivery/delivery.routes');
const wfconfigRoutes = require('./modules/wfconfig/wfconfig.routes');
const dashboardRoutes = require('./modules/dashboard/dashboard.routes');

const app = express();

app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => ok(res, { status: 'up', time: new Date().toISOString() }, 'OK'));

// Modules
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/modules', appmoduleRoutes);
app.use('/api/phan-in', ordersRoutes);
app.use('/api/ready', technicalRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/quality', qualityRoutes);
app.use('/api/giao-hang', deliveryRoutes);
app.use('/api/wf', wfconfigRoutes);
app.use('/api/dashboard', dashboardRoutes);

// 404 + error
app.use(notFound);
app.use(errorHandler);

module.exports = app;
