// Тестовые данные песочницы (XTENDER_SANDBOX=1): локальная scripts/api-sandbox.js и тестовое окружение на Railway
// (src/services/sandboxSeed.service.js при SANDBOX_SEED=1). Номера выдуманные, в именах пометка SANDBOX: SMS на них не
// уходят, коды входа лежат в приёмнике GET /api/v1/sandbox/sms.
const SANDBOX = {
  customer: '+995500000001',
  providers: [
    { phone: '+995500000002', name: 'SANDBOX Movers Giorgi', service: 'movers', attributes: { crew_size: 3 }, languages: ['ka', 'ru'], active: true,
      description: 'SANDBOX: loading, unloading, furniture assembly. Test profile, not a real person.' },
    { phone: '+995500000003', name: 'SANDBOX Van Levan', service: 'van', attributes: { size: 'L', body: 'closed', tail_lift: true, cargo_length_cm: 400, cargo_width_cm: 180, cargo_height_cm: 190 },
      languages: ['ru', 'en'], active: true, description: 'SANDBOX: closed van with a tail lift. Test profile, not a real person.' },
    { phone: '+995500000004', name: 'SANDBOX Junk Nika (pending)', service: 'junk', attributes: { volume_m3: '4' }, languages: ['ka'], active: false,
      description: 'SANDBOX: waste removal, awaiting moderation. Test profile, not a real person.' },
    { phone: '+995500000005', name: 'SANDBOX Movers Dato', service: 'movers', attributes: { crew_size: 2 }, languages: ['ru', 'en'], active: true,
      description: 'SANDBOX: movers, second test team for comparing offers. Test profile, not a real person.' },
    // Активный вывоз мусора: первая проверка в ChatGPT (2026-10-25) началась со строительного мусора, а был только Nika на модерации.
    { phone: '+995500000006', name: 'SANDBOX Junk Tamaz', service: 'junk', attributes: { volume_m3: '4', dump_body: true }, languages: ['ka', 'ru'], active: true,
      description: 'SANDBOX: construction and household waste removal, dump truck. Test profile, not a real person.' },
  ],
};

module.exports = { SANDBOX };
