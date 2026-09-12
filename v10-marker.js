const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);

    if (request === 'express' && typeof loaded === 'function' && !loaded.__audispotV10Wrapped) {
        const wrappedExpress = function (...args) {
            const app = loaded(...args);
            app.get('/__audispot_build', (req, res) => {
                res.status(200).json({
                    ok: true,
                    service: 'audispot',
                    build: 'v10-source-reconciliation',
                    source: 'github-main'
                });
            });
            app.get('/healthz-v10', (req, res) => {
                res.status(200).json({ ok: true, service: 'audispot', build: 'v10-source-reconciliation' });
            });
            return app;
        };

        Object.setPrototypeOf(wrappedExpress, loaded);
        Object.assign(wrappedExpress, loaded);
        wrappedExpress.__audispotV10Wrapped = true;
        return wrappedExpress;
    }

    return loaded;
};
