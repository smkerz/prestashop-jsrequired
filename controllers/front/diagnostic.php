<?php

/**
 * JSRequired - store last "blocked" diagnostic in configuration.
 */

class JsRequiredDiagnosticModuleFrontController extends ModuleFrontController
{
    public $ajax = true;

    public function initContent()
    {
        parent::initContent();

        header('Content-Type: application/json; charset=utf-8');

        try {
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                die(json_encode(['ok' => false, 'error' => 'method_not_allowed']));
            }

            $body = file_get_contents('php://input');
            $payload = json_decode($body, true);
            if (!is_array($payload)) {
                http_response_code(400);
                die(json_encode(['ok' => false, 'error' => 'invalid_json']));
            }

            $token = isset($payload['token']) ? (string) $payload['token'] : '';
            $expected = (string) Configuration::get(JsRequired::CONF_DIAG_TOKEN);
            if (!$expected || !$token || !hash_equals($expected, $token)) {
                http_response_code(403);
                die(json_encode(['ok' => false, 'error' => 'forbidden']));
            }

            $diag = isset($payload['diag']) && is_array($payload['diag']) ? $payload['diag'] : [];
            if (empty($diag)) {
                http_response_code(400);
                die(json_encode(['ok' => false, 'error' => 'missing_diag']));
            }

            // Only store when blocked
            $status = isset($diag['status']) ? (string) $diag['status'] : '';
            if ($status !== 'blocked') {
                die(json_encode(['ok' => true, 'ignored' => true]));
            }

            // Normalize / cap size
            $diag = array_slice($diag, 0, 60, true);
            $json = json_encode($diag);
            if ($json === false) {
                http_response_code(400);
                die(json_encode(['ok' => false, 'error' => 'encode_failed']));
            }
            if (strlen($json) > 10000) {
                $json = substr($json, 0, 10000);
            }

            Configuration::updateValue(JsRequired::CONF_LAST_DIAG, $json);
            Configuration::updateValue(JsRequired::CONF_LAST_DIAG_TS, time());

            die(json_encode(['ok' => true]));
        } catch (Exception $e) {
            http_response_code(500);
            die(json_encode(['ok' => false, 'error' => 'server_error']));
        }
    }
}
