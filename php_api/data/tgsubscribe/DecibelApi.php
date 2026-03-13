<?php
require_once 'baseFunction.php';

/**
 * class DecibelApi
 * str token
 * str encryptedData
 * int tgBotName
 */
class DecibelApi
{
	private $helpers;
	private $apikey;
	private $baseUrl;
	private $tableSnapshots;
	
	/**
	 * construct
	 */
	function __construct() {
		$this->helpers = new baseFunction();
		$this->apikey = 'aptoslabs_WHNSgNDtbdn_7v6Ky5KAYCS8DuLprPffgbre71DjZBg9o';
		$this->baseUrl = 'https://api.mainnet.aptoslabs.com/decibel';
		$this->tableSnapshots = '001_decibel_market_snapshots';
	}
	
	/**
	 * getData($data=[])
	 */
	public function getData($data=[])
	{
		$action = !empty($data['action']) ? (string)$data['action'] : 'save';

		switch ($action) {
			case 'aggregated':
				return $this->getAggregatedMarketsWithPrices();
			case 'save':
				return $this->saveAggregatedMarketsWithPricesToDb($data);
			case 'markets':
				return $this->getMarkets();
			case 'prices':
				return $this->getPrices();
			default:
				return [
					'success' => false,
					'error' => 'Unknown action',
					'action' => $action,
				];
		}
	}

	/**
	 * getMarkets()
	 * GET /api/v1/markets
	 */
	public function getMarkets()
	{
		return $this->request('/api/v1/markets');
	}

	/**
	 * getPrices()
	 * GET /api/v1/prices
	 */
	public function getPrices()
	{
		return $this->request('/api/v1/prices');
	}

	/**
	 * getAggregatedMarketsWithPrices()
	 * Объединяет /markets и /prices по market_addr => market.
	 */
	public function getAggregatedMarketsWithPrices()
	{
		$marketsResp = $this->getMarkets();
		$pricesResp  = $this->getPrices();

		if (empty($marketsResp['success']) || empty($pricesResp['success'])) {
			$errorParts = [];
			if (isset($marketsResp['error']) && $marketsResp['error'] !== '') {
				$errorParts[] = 'markets: ' . $marketsResp['error'];
			}
			if (isset($pricesResp['error']) && $pricesResp['error'] !== '') {
				$errorParts[] = 'prices: ' . $pricesResp['error'];
			}
			$errorMessage = !empty($errorParts)
				? implode('; ', $errorParts)
				: 'Failed to load markets or prices';

			return [
				'success' => false,
				'data' => [],
				'error' => $errorMessage,
			];
		}

		$markets = is_array($marketsResp['data'] ?? null) ? $marketsResp['data'] : [];
		$prices  = is_array($pricesResp['data'] ?? null) ? $pricesResp['data'] : [];

		// Индексируем рынки по market_addr
		$byAddr = [];
		foreach ($markets as $m) {
			if (empty($m['market_addr'])) {
				continue;
			}
			$addr = (string)$m['market_addr'];
			$byAddr[$addr] = $m; // сохраняем все поля market как есть
		}

		$result = [];

		// Базой берём prices и подмешиваем market-данные по ключу:
		// markets.market_addr => prices.market (fallback prices.market_addr)
		foreach ($prices as $p) {
			$priceMarketKey = '';
			if (!empty($p['market'])) {
				$priceMarketKey = (string)$p['market'];
			} elseif (!empty($p['market_addr'])) {
				$priceMarketKey = (string)$p['market_addr'];
			}

			if ($priceMarketKey === '') {
				continue;
			}

			$marketData = isset($byAddr[$priceMarketKey]) ? $byAddr[$priceMarketKey] : [];

			// Единая строка: все поля price + все поля market
			// (приоритет ключам price, чтобы не затереть актуальные метрики)
			$row = array_merge($marketData, $p);

			// Нормализуем служебные поля для БД
			$row['market_addr'] = $priceMarketKey;
			if (empty($row['market'])) {
				$row['market'] = $priceMarketKey;
			}

			$result[] = $row;
		}

		return [
			'success' => true,
			'data' => $result,
		];
	}

	/**
	 * saveAggregatedMarketsWithPricesToDb($data=[])
	 * Загружает aggregated данные и сохраняет их в БД.
	 * action=save, optional: table
	 */
	public function saveAggregatedMarketsWithPricesToDb($data=[])
	{
		$table = !empty($data['table']) ? (string)$data['table'] : $this->tableSnapshots;
		if (!preg_match('/^[a-zA-Z0-9_]+$/', $table)) {
			return [
				'success' => false,
				'saved' => 0,
				'error' => 'Invalid table name',
			];
		}

		$aggregated = $this->getAggregatedMarketsWithPrices();
		if (empty($aggregated['success']) || empty($aggregated['data']) || !is_array($aggregated['data'])) {
			return [
				'success' => false,
				'saved' => 0,
				'error' => !empty($aggregated['error']) ? $aggregated['error'] : 'No aggregated data to save',
			];
		}

		$saved = 0;
		$errors = [];

		foreach ($aggregated['data'] as $row) {
			$result = $this->upsertSnapshotRow($table, $row);
			if (!empty($result['success'])) {
				$saved++;
			} else {
				$errors[] = !empty($result['error']) ? $result['error'] : 'Unknown DB error';
			}
		}

		return [
			'success' => $saved > 0 && empty($errors),
			'saved' => $saved,
			'error' => !empty($errors) ? implode('; ', array_slice($errors, 0, 3)) : '',
		];
	}

	/**
	 * getFundig($data=[])
	 * Выборка funding/price данных за последние 24 часа.
	 * Optional: market_addr, table, limit
	 */
	public function getFundig($data=[])
	{
		$table = !empty($data['table']) ? (string)$data['table'] : $this->tableSnapshots;
		if (!preg_match('/^[a-zA-Z0-9_]+$/', $table)) {
			return [
				'success' => false,
				'data' => [],
				'error' => 'Invalid table name',
			];
		}

		$fromUnixMs = (time() - 86400) * 1000;
		$limit = !empty($data['limit']) ? (int)$data['limit'] : 5000;
		$weightedAverage = false;
		if (isset($data['weighted_average'])) {
			$weightedAverage = in_array(strtolower((string)$data['weighted_average']), ['1', 'true', 'yes', 'on'], true);
		}
		if ($limit <= 0) {
			$limit = 5000;
		}
		if ($limit > 50000) {
			$limit = 50000;
		}

		$sql = '
			SELECT *
			FROM `' . $table . '`
			WHERE `transaction_unix_ms` >= :from_unix_ms
		';
		$params = [
			':from_unix_ms' => $fromUnixMs,
		];

		if (!empty($data['market_addr'])) {
			$sql .= ' AND `market_addr` = :market_addr';
			$params[':market_addr'] = (string)$data['market_addr'];
		}

		if (!empty($data['market_name'])) {
			$marketNameRaw = trim((string)$data['market_name']);
			// Trading pair format: LETTERS/LETTERS, 1..5 chars each side (case-insensitive)
			if (!preg_match('/^[A-Z]{1,5}\/[A-Z]{1,5}$/i', $marketNameRaw)) {
				return [
					'success' => false,
					'data' => [],
					'error' => 'Invalid market_name format. Expected pair like APT/USD (letters only, max 5 per side)',
				];
			}

			$marketName = strtoupper($marketNameRaw);
			$sql .= ' AND UPPER(`market_name`) = :market_name';
			$params[':market_name'] = $marketName;
		}

		$sql .= '
			ORDER BY `transaction_unix_ms` DESC
			LIMIT ' . (int)$limit . '
		';

		$result = $this->helpers->queryParams($sql, $params, 'fetchAll');
		if (!empty($result) && isset($result['completed']) && is_array($result['completed'])) {
			$rows = [];
			foreach ($result['completed'] as $row) {
				if (!is_array($row)) {
					continue;
				}
				$rows[] = [
					'market_name' => isset($row['market_name']) ? (string)$row['market_name'] : '',
					'sz_decimals' => isset($row['sz_decimals']) ? (int)$row['sz_decimals'] : 0,
					'oracle_px' => isset($row['oracle_px']) ? (float)$row['oracle_px'] : 0,
					'mark_px' => isset($row['mark_px']) ? (float)$row['mark_px'] : 0,
					'mid_px' => isset($row['mid_px']) ? (float)$row['mid_px'] : 0,
					'funding_rate_bps' => isset($row['funding_rate_bps']) ? (float)$row['funding_rate_bps'] : 0,
					'is_funding_positive' => !empty($row['is_funding_positive']) ? 1 : 0,
					'transaction_unix_ms' => isset($row['transaction_unix_ms']) ? (int)$row['transaction_unix_ms'] : 0,
					'open_interest' => isset($row['open_interest']) ? (float)$row['open_interest'] : 0,
					'creation_date' => isset($row['creation_date']) ? (string)$row['creation_date'] : '',
				];
			}

			return [
				'success' => true,
				'data' => $rows,
				'weighted_average' => $weightedAverage ? $this->buildFundingWeightedAverage($rows) : null,
				'error' => '',
			];
		}

		return [
			'success' => false,
			'data' => [],
			'error' => !empty($result['info']) ? (is_array($result['info']) ? implode(' | ', $result['info']) : (string)$result['info']) : 'DB query failed',
		];
	}

	/**
	 * buildFundingWeightedAverage($rows=[])
	 * Time-weighted funding APR analytics for current selection.
	 */
	private function buildFundingWeightedAverage($rows=[])
	{
		if (empty($rows) || !is_array($rows)) {
			return [
				'success' => false,
				'error' => 'No data for weighted_average',
			];
		}

		$records = [];
		$positiveCount = 0;
		foreach ($rows as $r) {
			if (!is_array($r)) {
				continue;
			}

			$bps = isset($r['funding_rate_bps']) ? (float)$r['funding_rate_bps'] : 0.0;
			$isPositive = !empty($r['is_funding_positive']) ? 1 : 0;
			$timeMs = isset($r['transaction_unix_ms']) ? (int)$r['transaction_unix_ms'] : 0;
			if ($timeMs <= 0) {
				continue;
			}

			if ($isPositive === 1) {
				$positiveCount++;
			}

			$records[] = [
				'time' => $timeMs,
				'signed_bps' => $isPositive === 1 ? $bps : -1 * $bps,
				'is_positive' => $isPositive,
			];
		}

		$totalRecords = count($records);
		if ($totalRecords < 2) {
			return [
				'success' => false,
				'error' => 'Not enough points for weighted_average (need at least 2)',
				'records_total' => $totalRecords,
			];
		}

		// Sort from oldest to newest (required for correct time deltas)
		usort($records, function($a, $b) {
			return $a['time'] <=> $b['time'];
		});

		$totalWeightedBps = 0.0;
		$totalTimeMs = 0;
		for ($i = 0; $i < $totalRecords - 1; $i++) {
			$current = $records[$i];
			$next = $records[$i + 1];
			$deltaMs = (int)$next['time'] - (int)$current['time'];
			if ($deltaMs <= 0) {
				continue;
			}

			$totalWeightedBps += ((float)$current['signed_bps'] * $deltaMs);
			$totalTimeMs += $deltaMs;
		}

		if ($totalTimeMs <= 0) {
			return [
				'success' => false,
				'error' => 'Invalid timeline for weighted_average',
				'records_total' => $totalRecords,
			];
		}

		// Time-weighted mean funding rate in bps (interval-aware).
		$avgBps = $totalWeightedBps / $totalTimeMs;
		$aprPercent = ($avgBps * 24 * 365) / 100;
		$positivePercent = ($positiveCount / $totalRecords) * 100;

		return [
			'success' => true,
			'avg_bps_time_weighted' => round($avgBps, 8),
			'avg_yearly_apr_pct' => round($aprPercent, 4),
			'direction' => $aprPercent > 0 ? 'Longs pay Shorts' : ($aprPercent < 0 ? 'Shorts pay Longs' : 'Neutral'),
			'positive_time_pct' => round($positivePercent, 2),
			'records_total' => $totalRecords,
			'total_time_ms' => $totalTimeMs,
		];
	}

	/**
	 * upsertSnapshotRow($table='', $row=[])
	 */
	private function upsertSnapshotRow($table='', $row=[])
	{
		if (empty($table) || empty($row) || !is_array($row)) {
			return ['success' => false, 'error' => 'Invalid save payload'];
		}

		$sql = '
			INSERT INTO `' . $table . '`
			(
				`market_addr`,
				`market_name`,
				`sz_decimals`,
				`max_leverage`,
				`tick_size`,
				`min_size`,
				`lot_size`,
				`max_open_interest`,
				`px_decimals`,
				`mode`,
				`unrealized_pnl_haircut_bps`,
				`oracle_px`,
				`mark_px`,
				`mid_px`,
				`funding_rate_bps`,
				`is_funding_positive`,
				`transaction_unix_ms`,
				`open_interest`,
				`creation_date`
			)
			VALUES
			(
				:market_addr,
				:market_name,
				:sz_decimals,
				:max_leverage,
				:tick_size,
				:min_size,
				:lot_size,
				:max_open_interest,
				:px_decimals,
				:mode,
				:unrealized_pnl_haircut_bps,
				:oracle_px,
				:mark_px,
				:mid_px,
				:funding_rate_bps,
				:is_funding_positive,
				:transaction_unix_ms,
				:open_interest,
				:creation_date
			)
			ON DUPLICATE KEY UPDATE
				`market_name` = VALUES(`market_name`),
				`sz_decimals` = VALUES(`sz_decimals`),
				`max_leverage` = VALUES(`max_leverage`),
				`tick_size` = VALUES(`tick_size`),
				`min_size` = VALUES(`min_size`),
				`lot_size` = VALUES(`lot_size`),
				`max_open_interest` = VALUES(`max_open_interest`),
				`px_decimals` = VALUES(`px_decimals`),
				`mode` = VALUES(`mode`),
				`unrealized_pnl_haircut_bps` = VALUES(`unrealized_pnl_haircut_bps`),
				`oracle_px` = VALUES(`oracle_px`),
				`mark_px` = VALUES(`mark_px`),
				`mid_px` = VALUES(`mid_px`),
				`funding_rate_bps` = VALUES(`funding_rate_bps`),
				`is_funding_positive` = VALUES(`is_funding_positive`),
				`transaction_unix_ms` = VALUES(`transaction_unix_ms`),
				`open_interest` = VALUES(`open_interest`)
		';

		$params = [
			':market_addr' => !empty($row['market_addr']) ? (string)$row['market_addr'] : '',
			':market_name' => !empty($row['market_name']) ? (string)$row['market_name'] : '',
			':sz_decimals' => isset($row['sz_decimals']) ? (int)$row['sz_decimals'] : 0,
			':max_leverage' => isset($row['max_leverage']) ? (float)$row['max_leverage'] : 0,
			':tick_size' => isset($row['tick_size']) ? (float)$row['tick_size'] : 0,
			':min_size' => isset($row['min_size']) ? (float)$row['min_size'] : 0,
			':lot_size' => isset($row['lot_size']) ? (float)$row['lot_size'] : 0,
			':max_open_interest' => isset($row['max_open_interest']) ? (float)$row['max_open_interest'] : 0,
			':px_decimals' => isset($row['px_decimals']) ? (int)$row['px_decimals'] : 0,
			':mode' => isset($row['mode']) ? (string)$row['mode'] : '',
			':unrealized_pnl_haircut_bps' => isset($row['unrealized_pnl_haircut_bps']) ? (int)$row['unrealized_pnl_haircut_bps'] : 0,
			':oracle_px' => isset($row['oracle_px']) ? (float)$row['oracle_px'] : 0,
			':mark_px' => isset($row['mark_px']) ? (float)$row['mark_px'] : 0,
			':mid_px' => isset($row['mid_px']) ? (float)$row['mid_px'] : 0,
			':funding_rate_bps' => isset($row['funding_rate_bps']) ? (float)$row['funding_rate_bps'] : 0,
			':is_funding_positive' => !empty($row['is_funding_positive']) ? 1 : 0,
			':transaction_unix_ms' => isset($row['transaction_unix_ms']) ? (int)$row['transaction_unix_ms'] : 0,
			':open_interest' => isset($row['open_interest']) ? (float)$row['open_interest'] : 0,
			':creation_date' => date('Y-m-d H:i:s'),
		];

		$result = $this->helpers->queryParams($sql, $params);
		if (!empty($result) && !empty($result['completed'])) {
			return ['success' => true];
		}

		return [
			'success' => false,
			'error' => !empty($result['info']) ? (is_array($result['info']) ? implode(' | ', $result['info']) : (string)$result['info']) : 'DB query failed',
		];
	}

	/**
	 * request($path, $query=[])
	 */
	private function request($path='', $query=[])
	{
		if (empty($this->apikey)) {
			return [
				'success' => false,
				'error' => 'Decibel API key is empty',
			];
		}

		$url = rtrim($this->baseUrl, '/') . '/' . ltrim($path, '/');
		if (!empty($query) && is_array($query)) {
			$url .= '?' . http_build_query($query);
		}

		$ch = curl_init($url);
		curl_setopt_array($ch, [
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_TIMEOUT => 30,
			CURLOPT_HTTPHEADER => [
				'Accept: application/json',
				'Authorization: Bearer ' . $this->apikey,
			],
		]);

		$response = curl_exec($ch);
		$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
		$curlError = curl_error($ch);
		curl_close($ch);

		if ($response === false) {
			return [
				'success' => false,
				'error' => !empty($curlError) ? $curlError : 'Curl request failed',
			];
		}

		$payload = json_decode($response, true);
		if (!is_array($payload)) {
			return [
				'success' => false,
				'status' => $httpCode,
				'error' => 'Invalid JSON response',
				'raw' => $response,
			];
		}

		if ($httpCode < 200 || $httpCode >= 300) {
			return [
				'success' => false,
				'status' => $httpCode,
				'error' => 'Decibel API error',
				'data' => $payload,
			];
		}

		return [
			'success' => true,
			'status' => $httpCode,
			'data' => $payload,
		];
	}
	
	/**
	 * class($className=__CLASS__)
	 */ 
	public static function tg($className=__CLASS__)
	{
		return new $className;
	}
}