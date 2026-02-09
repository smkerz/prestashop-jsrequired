<?php
if (!defined('_PS_VERSION_')) {
    exit;
}

class JsRequired extends Module
{
    private static $rendered = false;

    const CONF_DIAG_TOKEN = 'JSREQUIRED_DIAG_TOKEN';
    const CONF_LAST_DIAG = 'JSREQUIRED_LAST_DIAG';
    const CONF_LAST_DIAG_TS = 'JSREQUIRED_LAST_DIAG_TS';

    public function __construct()
    {
        $this->name = 'jsrequired';
        $this->tab = 'front_office_features';
        $this->version = '2.9.10';
        $this->author = 'Custom';
        $this->need_instance = 0;
        $this->bootstrap = true;

        parent::__construct();

        $this->displayName = $this->l('Checkout JS / payment widget warning');
        $this->description = $this->l('Shows a banner when JavaScript is disabled and warns when blockers/CSP prevent payment widgets (Revolut / Stripe / PayPal / PrestaShop Checkout) from loading.');
        $this->ps_versions_compliancy = ['min' => '1.7.0.0', 'max' => _PS_VERSION_];
    }

    public function install()
    {
        return parent::install()
            && $this->registerHook('displayPaymentTop')
            && $this->registerHook('displayAfterBodyOpeningTag')
            && $this->registerHook('displayHeader')
            && $this->registerHook('actionFrontControllerSetMedia')
            && Configuration::updateValue('JSREQUIRED_ONLY_CHECKOUT', 1)
            && Configuration::updateValue('JSREQUIRED_SHOW_BANNER', 1)
            && Configuration::updateValue('JSREQUIRED_SHOW_INLINE', 1)
            && Configuration::updateValue('JSREQUIRED_MESSAGE',
                'JavaScript est désactivé dans votre navigateur. Pour finaliser votre commande et le paiement, veuillez l’activer puis recharger la page.'
            )
            && Configuration::updateValue('JSREQUIRED_DETECT_BLOCKERS', 1)
            && Configuration::updateValue('JSREQUIRED_BLOCKER_MESSAGE',
                'Le paiement ne peut pas s’afficher : votre navigateur/extension (NoScript, AdBlock, anti‑tracker) ou une règle de sécurité (CSP) bloque des scripts/iframes nécessaires au paiement (Revolut / Stripe / PayPal). Autorisez-les puis rechargez la page.'
            )
            && Configuration::updateValue('JSREQUIRED_WHATSAPP_URL', 'https://wa.me/0000000?text=J%27ai%20un%20probl%C3%A8me%20avec%20le%20paiement%20de%20ma%20commande%20...')
            && Configuration::updateValue('JSREQUIRED_DEBUG', 0)
            && $this->initDiagnosticStorage();
    }

    public function uninstall()
    {
        return parent::uninstall()
            && Configuration::deleteByName('JSREQUIRED_ONLY_CHECKOUT')
            && Configuration::deleteByName('JSREQUIRED_SHOW_BANNER')
            && Configuration::deleteByName('JSREQUIRED_SHOW_INLINE')
            && Configuration::deleteByName('JSREQUIRED_MESSAGE')
            && Configuration::deleteByName('JSREQUIRED_DETECT_BLOCKERS')
            && Configuration::deleteByName('JSREQUIRED_BLOCKER_MESSAGE')
            && Configuration::deleteByName('JSREQUIRED_WHATSAPP_URL')
            && Configuration::deleteByName('JSREQUIRED_DEBUG')
            && Configuration::deleteByName(self::CONF_DIAG_TOKEN)
            && Configuration::deleteByName(self::CONF_LAST_DIAG)
            && Configuration::deleteByName(self::CONF_LAST_DIAG_TS);
    }

    private function initDiagnosticStorage()
    {
        if (!Configuration::get(self::CONF_DIAG_TOKEN)) {
            // Token used to protect the front diagnostic endpoint from public spam.
            $token = Tools::passwdGen(32);
            Configuration::updateValue(self::CONF_DIAG_TOKEN, $token);
        }
        if (!Configuration::hasKey(self::CONF_LAST_DIAG)) {
            Configuration::updateValue(self::CONF_LAST_DIAG, '');
        }
        if (!Configuration::hasKey(self::CONF_LAST_DIAG_TS)) {
            Configuration::updateValue(self::CONF_LAST_DIAG_TS, 0);
        }
        return true;
    }

    public function getContent()
    {
        $output = '';

        if (Tools::isSubmit('submitJsRequired')) {
            $onlyCheckout = (int) Tools::getValue('JSREQUIRED_ONLY_CHECKOUT');
            $showBanner = (int) Tools::getValue('JSREQUIRED_SHOW_BANNER');
            $showInline = (int) Tools::getValue('JSREQUIRED_SHOW_INLINE');
            $message = (string) Tools::getValue('JSREQUIRED_MESSAGE');

            $detectBlockers = (int) Tools::getValue('JSREQUIRED_DETECT_BLOCKERS');
            $blockerMessage = (string) Tools::getValue('JSREQUIRED_BLOCKER_MESSAGE');

            $whatsappUrl = (string) Tools::getValue('JSREQUIRED_WHATSAPP_URL');

            $debug = (int) Tools::getValue('JSREQUIRED_DEBUG');

            if (trim($message) === '' || trim($blockerMessage) === '') {
                $output .= $this->displayError($this->l('Messages cannot be empty.'));
            } else {
                Configuration::updateValue('JSREQUIRED_ONLY_CHECKOUT', $onlyCheckout);
                Configuration::updateValue('JSREQUIRED_SHOW_BANNER', $showBanner);
                Configuration::updateValue('JSREQUIRED_SHOW_INLINE', $showInline);
                Configuration::updateValue('JSREQUIRED_MESSAGE', $message);

                Configuration::updateValue('JSREQUIRED_DETECT_BLOCKERS', $detectBlockers);
                Configuration::updateValue('JSREQUIRED_BLOCKER_MESSAGE', $blockerMessage);

                Configuration::updateValue('JSREQUIRED_WHATSAPP_URL', $whatsappUrl);

                Configuration::updateValue('JSREQUIRED_DEBUG', $debug);

                $output .= $this->displayConfirmation($this->l('Settings updated.'));
            }
        }

        return $output . $this->renderForm() . $this->renderLastDetectionPanel();
    }

    private function renderLastDetectionPanel()
    {
        $raw = (string) Configuration::get(self::CONF_LAST_DIAG);
        $ts = (int) Configuration::get(self::CONF_LAST_DIAG_TS);

        $diag = [];
        if ($raw) {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $diag = $decoded;
            }
        }

        $has = !empty($diag) && $ts > 0;

        $dt = $has ? date('Y-m-d H:i:s', $ts) : $this->l('No detection stored yet.');
        $provider = $has ? (string) ($diag['provider'] ?? '') : '';
        $reason = $has ? (string) ($diag['reason'] ?? '') : '';
        $expected = $has ? (string) ($diag['expected'] ?? '') : '';
        $found = $has ? (string) ($diag['found'] ?? '') : '';
        $url = $has ? (string) ($diag['url'] ?? '') : '';
        $ua = $has ? (string) ($diag['ua'] ?? '') : '';
        $summary = $has ? (string) ($diag['summary'] ?? '') : '';

        $html = '<div class="panel">';
        $html .= '<h3>' . $this->l('Dernière détection') . '</h3>';
        $html .= '<p style="margin-bottom:10px;">' . $this->l('Stocké uniquement lorsqu\'un paiement est bloqué côté front.') . '</p>';

        $html .= '<div class="row">';
        $html .= '<div class="col-lg-12">';
        $html .= '<table class="table">';
        $html .= '<tr><th style="width:220px;">' . $this->l('Date') . '</th><td>' . htmlspecialchars($dt, ENT_QUOTES, 'UTF-8') . '</td></tr>';
        $html .= '<tr><th>' . $this->l('Provider') . '</th><td>' . htmlspecialchars($provider, ENT_QUOTES, 'UTF-8') . '</td></tr>';
        $html .= '<tr><th>' . $this->l('Élément attendu') . '</th><td><code>' . htmlspecialchars($expected, ENT_QUOTES, 'UTF-8') . '</code></td></tr>';
        $html .= '<tr><th>' . $this->l('Trouvé') . '</th><td>' . htmlspecialchars($found, ENT_QUOTES, 'UTF-8') . '</td></tr>';
        $html .= '<tr><th>' . $this->l('Raison') . '</th><td>' . htmlspecialchars($reason, ENT_QUOTES, 'UTF-8') . '</td></tr>';
        $html .= '<tr><th>' . $this->l('URL') . '</th><td style="word-break:break-all;">' . htmlspecialchars($url, ENT_QUOTES, 'UTF-8') . '</td></tr>';
        $html .= '<tr><th>' . $this->l('User-Agent') . '</th><td style="word-break:break-all;">' . htmlspecialchars($ua, ENT_QUOTES, 'UTF-8') . '</td></tr>';
        $html .= '</table>';
        $html .= '</div>';
        $html .= '</div>';

        $html .= '<div class="form-group">';
        $html .= '<label><strong>' . $this->l('Copier le diagnostic') . '</strong></label>';
        $html .= '<textarea id="jsrequired-bo-diagnostic" class="form-control" rows="6" readonly>' . htmlspecialchars($summary ?: $this->l('Aucun diagnostic disponible.'), ENT_QUOTES, 'UTF-8') . '</textarea>';
        $html .= '<p class="help-block" style="margin-top:6px;">' . $this->l('Ce texte est prêt à être envoyé au support.') . '</p>';
        $html .= '<button type="button" class="btn btn-default" id="jsrequired-bo-copy" ' . ($has ? '' : 'disabled') . '>' . $this->l('Copier') . '</button>';
        $html .= '</div>';

        $html .= '<script>(function(){var b=document.getElementById("jsrequired-bo-copy");if(!b)return;b.addEventListener("click",function(){var t=document.getElementById("jsrequired-bo-diagnostic");if(!t)return;try{t.select();t.setSelectionRange(0,999999);document.execCommand("copy");}catch(e){};});})();</script>';

        $html .= '</div>';

        return $html;
    }

    protected function renderForm()
    {
        $fieldsForm = [
            'form' => [
                'legend' => ['title' => $this->l('Settings'), 'icon' => 'icon-cogs'],
                'input' => [
                    [
                        'type' => 'switch',
                        'label' => $this->l('Show only on checkout'),
                        'name' => 'JSREQUIRED_ONLY_CHECKOUT',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'active_on',  'value' => 1, 'label' => $this->l('Yes')],
                            ['id' => 'active_off', 'value' => 0, 'label' => $this->l('No (all front office pages)')],
                        ],
                    ],
                    [
                        'type' => 'textarea',
                        'label' => $this->l('Message when JavaScript is disabled'),
                        'name' => 'JSREQUIRED_MESSAGE',
                        'rows' => 3,
                        'cols' => 60,
                        'required' => true,
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Detect blockers / CSP (Revolut / Stripe widgets missing)'),
                        'name' => 'JSREQUIRED_DETECT_BLOCKERS',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'det_on',  'value' => 1, 'label' => $this->l('Yes')],
                            ['id' => 'det_off', 'value' => 0, 'label' => $this->l('No')],
                        ],
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Show sticky top banner'),
                        'name' => 'JSREQUIRED_SHOW_BANNER',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'banner_on',  'value' => 1, 'label' => $this->l('Yes')],
                            ['id' => 'banner_off', 'value' => 0, 'label' => $this->l('No')],
                        ],
                        'desc' => $this->l('When blocked, display a sticky warning banner at the top of the page.'),
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Show inline message in the selected payment block'),
                        'name' => 'JSREQUIRED_SHOW_INLINE',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'inline_on',  'value' => 1, 'label' => $this->l('Yes')],
                            ['id' => 'inline_off', 'value' => 0, 'label' => $this->l('No')],
                        ],
                        'desc' => $this->l('When blocked, display a warning inside the selected payment option block.'),
                    ],
                    [
                        'type' => 'textarea',
                        'label' => $this->l('Message when blockers are detected'),
                        'name' => 'JSREQUIRED_BLOCKER_MESSAGE',
                        'rows' => 4,
                        'cols' => 60,
                        'required' => true,
                    ],
                    [
                        'type' => 'text',
                        'label' => $this->l('WhatsApp support link'),
                        'name' => 'JSREQUIRED_WHATSAPP_URL',
                        'desc' => $this->l('Optional. If set, a WhatsApp assistance link is shown in the banner.'),
                        'required' => false,
                        'col' => 8,
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Debug mode'),
                        'name' => 'JSREQUIRED_DEBUG',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'dbg_on',  'value' => 1, 'label' => $this->l('Yes')],
                            ['id' => 'dbg_off', 'value' => 0, 'label' => $this->l('No')],
                        ],
                        'desc' => $this->l('Logs detection details to the browser console.'),
                    ],
                ],
                'submit' => ['title' => $this->l('Save')],
            ],
        ];

        $helper = new HelperForm();
        $helper->show_toolbar = false;
        $helper->module = $this;
        $helper->default_form_language = (int) $this->context->language->id;
        $helper->allow_employee_form_lang = (int) Configuration::get('PS_BO_ALLOW_EMPLOYEE_FORM_LANG');
        $helper->identifier = $this->identifier;
        $helper->submit_action = 'submitJsRequired';
        $helper->currentIndex = $this->context->link->getAdminLink('AdminModules', false)
            . '&configure=' . $this->name . '&tab_module=' . $this->tab . '&module_name=' . $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');

        $helper->fields_value = [
            'JSREQUIRED_ONLY_CHECKOUT' => (int) Configuration::get('JSREQUIRED_ONLY_CHECKOUT'),
            'JSREQUIRED_SHOW_BANNER' => (int) Configuration::get('JSREQUIRED_SHOW_BANNER'),
            'JSREQUIRED_SHOW_INLINE' => (int) Configuration::get('JSREQUIRED_SHOW_INLINE'),
            'JSREQUIRED_MESSAGE' => (string) Configuration::get('JSREQUIRED_MESSAGE'),
            'JSREQUIRED_DETECT_BLOCKERS' => (int) Configuration::get('JSREQUIRED_DETECT_BLOCKERS'),
            'JSREQUIRED_BLOCKER_MESSAGE' => (string) Configuration::get('JSREQUIRED_BLOCKER_MESSAGE'),
            'JSREQUIRED_WHATSAPP_URL' => (string) Configuration::get('JSREQUIRED_WHATSAPP_URL'),
            'JSREQUIRED_DEBUG' => (int) Configuration::get('JSREQUIRED_DEBUG'),
        ];

        return $helper->generateForm([$fieldsForm]);
    }

    private function shouldRunHere()
    {
        if ((int) Configuration::get('JSREQUIRED_ONLY_CHECKOUT') !== 1) {
            return true;
        }
        $phpSelf = isset($this->context->controller->php_self) ? (string) $this->context->controller->php_self : '';
        return ($phpSelf === 'order');
    }

    private function renderBanner()
    {
        if (self::$rendered) {
            return '';
        }
        self::$rendered = true;

        $showBanner = ((int) Configuration::get('JSREQUIRED_SHOW_BANNER') === 1);
        $showInline = ((int) Configuration::get('JSREQUIRED_SHOW_INLINE') === 1);
        if (!$showBanner && !$showInline) {
            return '';
        }

        $ver = (string) $this->version;
        $this->context->smarty->assign([
            'jsrequired_message' => (string) Configuration::get('JSREQUIRED_MESSAGE'),
            'jsrequired_blocker_message' => (string) Configuration::get('JSREQUIRED_BLOCKER_MESSAGE'),
            'jsrequired_whatsapp_url' => (string) Configuration::get('JSREQUIRED_WHATSAPP_URL'),
            'jsrequired_show_banner' => $showBanner,
            'jsrequired_show_inline' => $showInline,
            'jsrequired_version' => $ver,
            // Fallback script injection (external script, compatible with strict CSP that blocks inline scripts)
            'jsrequired_script_url' => $this->_path . 'views/js/jsrequired.js?v=' . rawurlencode($ver),
        ]);

        return $this->fetch('module:jsrequired/views/templates/hook/banner.tpl');
    }

    public function hookDisplayPaymentTop($params)
    {
        if (!$this->shouldRunHere()) {
            return '';
        }
        return $this->renderBanner();
    }

    public function hookDisplayAfterBodyOpeningTag($params)
    {
        if (!$this->shouldRunHere()) {
            return '';
        }
        return $this->renderBanner();
    }

    public function hookDisplayHeader($params)
    {
        $this->registerAssetsIfNeeded();
    }

    public function hookActionFrontControllerSetMedia($params)
    {
        $this->registerAssetsIfNeeded();
    }

    private function registerAssetsIfNeeded()
    {
        if ((int) Configuration::get('JSREQUIRED_DETECT_BLOCKERS') !== 1) {
            return;
        }
        if (!$this->shouldRunHere()) {
            return;
        }

        // Ensure diagnostic token exists (for modules upgraded from older versions)
        $this->initDiagnosticStorage();

        // Expose config to JS (used for dynamic banner creation fallback)
        Media::addJsDef([
            'jsrequiredDebug' => ((int) Configuration::get('JSREQUIRED_DEBUG') === 1),
            'jsrequiredVersion' => (string) $this->version,
            'jsrequiredBlockerMessage' => (string) Configuration::get('JSREQUIRED_BLOCKER_MESSAGE'),
            'jsrequiredShowBanner' => ((int) Configuration::get('JSREQUIRED_SHOW_BANNER') === 1),
            'jsrequiredShowInline' => ((int) Configuration::get('JSREQUIRED_SHOW_INLINE') === 1),
            'jsrequiredWhatsAppUrl' => (string) Configuration::get('JSREQUIRED_WHATSAPP_URL'),
            'jsrequiredDiagUrl' => $this->context->link->getModuleLink($this->name, 'diagnostic', [], true),
            'jsrequiredDiagToken' => (string) Configuration::get(self::CONF_DIAG_TOKEN),
        ]);

        if (isset($this->context->controller) && method_exists($this->context->controller, 'registerJavascript')) {
            $v = str_replace('.', '', (string) $this->version);
            $this->context->controller->registerJavascript(
                'module-jsrequired-detect',
                'modules/' . $this->name . '/views/js/jsrequired.js?v=' . $v,
                ['position' => 'head', 'priority' => 1]
            );
        }
    }
}
