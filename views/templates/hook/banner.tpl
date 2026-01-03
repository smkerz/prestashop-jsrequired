{* jsrequired banner v2.x *}
<!-- jsrequired-banner injected -->
<noscript>
  <div class="alert alert-danger" role="alert" style="margin:0 0 12px 0;border-radius:0;">
    {$jsrequired_message|escape:'html':'UTF-8'}
    {if isset($jsrequired_whatsapp_url) && $jsrequired_whatsapp_url}
      <div style="margin-top:8px;">
        <a href="{$jsrequired_whatsapp_url|escape:'html':'UTF-8'}" target="_blank" rel="noopener" style="text-decoration:underline;">
          Besoin d’aide ? Contactez-nous sur WhatsApp
        </a>
      </div>
    {/if}
  </div>
</noscript>

<div id="jsrequired-blocker-banner"
     data-jsrequired-version="{$jsrequired_version|escape:'html':'UTF-8'}"
     data-jsrequired-reason=""
     role="alert"
     class="alert alert-warning"
     style="display:none;position:fixed;top:0;left:0;right:0;z-index:999999;padding:12px 16px;margin:0;border-radius:0;">
  <div style="display:flex;gap:12px;align-items:flex-start;justify-content:space-between;">
    <div style="flex:1;min-width:0;">
      <div id="jsrequired-blocker-banner-message">{$jsrequired_blocker_message|escape:'html':'UTF-8'}</div>
      <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
        <button type="button" class="jsrequired-reload" style="padding:6px 10px;border:1px solid currentColor;border-radius:4px;background:transparent;cursor:pointer;">
          Recharger la page
        </button>
        <button type="button" class="jsrequired-copy-diagnostic" style="padding:6px 10px;border:1px solid currentColor;border-radius:4px;background:transparent;cursor:pointer;">
          Copier le diagnostic
        </button>
        {if isset($jsrequired_whatsapp_url) && $jsrequired_whatsapp_url}
          <a id="jsrequired-whatsapp-link" href="{$jsrequired_whatsapp_url|escape:'html':'UTF-8'}" target="_blank" rel="noopener" style="text-decoration:underline;">
            Assistance WhatsApp
          </a>
        {/if}
      </div>
    </div>
    <button type="button"
            aria-label="Fermer"
            id="jsrequired-blocker-close"
            style="background:transparent;border:0;font-size:20px;line-height:20px;padding:0 6px;cursor:pointer;">
      ×
    </button>
  </div>
</div>

{* Fallback JS loader: some themes/controllers do not reliably register module assets on checkout.
   This is an external script (no inline JS), compatible with strict CSP that blocks inline scripts. *}
{if isset($jsrequired_script_url) && $jsrequired_script_url}
  <script id="jsrequired-script" src="{$jsrequired_script_url|escape:'html':'UTF-8'}" defer></script>
{/if}
