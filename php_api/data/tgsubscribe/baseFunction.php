<?php

/**
 * class TGCron
 */
class baseFunction
{
	public $TelegramBotApiUrl = false;
	public $BotApiUrl = false;
	public $YieldaiApiUrl = false;
	public $countRows = 40;
	public $api_key = '';
	
	private $db_name = false;
	private $prefix = false;
	private $connection = null;
	
	/**
	 * construct
	 */
	function __construct() {
		$this->TelegramBotApiUrl = 'https://api.telegram.org/bot';
		$this->YieldaiApiUrl = 'https://yieldai.app/api/public/v1/wallet/';
		$this->BotApiUrl = 'https://yieldai.aoserver.ru/?tgData';
		$this->api_key = 'ledgerdao';
	}

	/**
	 * formatWalletBalance($data=[])
	 */
	public function formatWalletBalance($data=[], $previousTotalAssets=null) 
	{
		if (empty($data) || !is_array($data)) {
			return false;
		}
		
		$addressShort = substr($data['balance']['address'], 0, 6) . '...' . substr($data['balance']['address'], -6);

		$dt = new DateTime($data['balance']['timestamp']);
		$dateStr = $dt->format('d.m.Y H:i');
		
		$protocolsData = (!empty($data['protocols']) && is_array($data['protocols']))
			? $data['protocols']
			: [];
		$totalAssets = $this->calculateTotalAssetsFromProtocols([
			'protocols' => (!empty($protocolsData['protocols']) && is_array($protocolsData['protocols'])) ? $protocolsData['protocols'] : [],
		]);
		$trendEmoji = $this->getTotalAssetsTrendEmoji($totalAssets, $previousTotalAssets);
		$trendSuffix = $trendEmoji !== '' ? ' ' . $trendEmoji : '';
		
		// Start building message
		$message = "💰 *TOTAL ASSETS{$trendSuffix}: \$" . number_format($totalAssets, 2) . "*\n";
		$message .= "\n";
		$message .= "💰 *WALLET BALANCE*\n";
		$message .= "\n";
		$message .= "👤 Address: `{$addressShort}`\n";
		$message .= "📅 Updated: {$dateStr} UTC\n";
		$message .= "\n";
		$message .= "💳 *Tokens:*";
		
		$totalUsd = 0;
		$hiddenAssetsCount = 0;
		
		foreach ($data['balance']['tokens'] as $token) {
			
			if (empty($token['decimals']) || empty($token['priceUSD']) || empty($token['symbol'])) {
				continue;
			}

			$tokenValueUsd = (float)$token['valueUSD'];
			$totalUsd += $tokenValueUsd;
			if ($tokenValueUsd < 1) {
				$hiddenAssetsCount++;
				continue;
			}

			$emoji = $this->getTokenEmoji($token['symbol']);
			$amount = $token['amount'];
			$price = number_format((float)$token['priceUSD'], 2);
			$value = number_format($tokenValueUsd, 2);
			
			$message .= "\n\n";
			$message .= "  {$emoji} *{$token['symbol']}*\n";
			$message .= "  ┣ 📊 Balance: `{$amount}`\n";
			$message .= "  ┣ 💰 Price: \${$price}\n";
			$message .= "  ┗ 💵 Value: \${$value}";
		}
		
		if ($hiddenAssetsCount > 0) {
			$message .= "\n\n";
			$message .= "({$hiddenAssetsCount}) assets with value below <1$ are hidden";
		}

		$totalFormatted = number_format($totalUsd, 2);
		
		$message .= "\n\n";
		$message .= "💰 *TOTAL VALUE WALLET: \${$totalFormatted}*\n";
		$message .= "\n\n";
		
		$message .= $this->formatInvestmentPortfolio($data['protocols'], $totalUsd, $previousTotalAssets);
		
		return $message;
	}
	
	/**
	 * formatProtocolPosition($protocol='', $position='') 
	 */
	public function formatProtocolPosition($protocol='', $position='') 
	{
		$result = [
			'message' => '',
			'valueUSD' => 0,
		];
		
		switch ($protocol) {
			case 'echelon':
			case 'aries':
				if (isset($position['coin'])) {
					$coinEmoji = $this->getTokenEmoji($this->getSymbolFromCoin($position['coin']));
					$amount = $position['amount'] / 1000000; // Convert from decimals
					$type = $position['type'] == 'supply' ? '💰 Supplied' : '📉 Borrowed';
					$result['message'] .= "  ┣ {$coinEmoji} {$type}: `" . number_format($amount, 2) . "`\n";
					// Do not treat token amount as USD.
					// Add to TOTAL ASSETS only when explicit USD value exists in payload.
					$usdValue = null;
					if (isset($position['valueUSD']) && is_numeric($position['valueUSD'])) {
						$usdValue = (float)$position['valueUSD'];
					} elseif (isset($position['usd']) && is_numeric($position['usd'])) {
						$usdValue = (float)$position['usd'];
					} elseif (isset($position['value']) && is_numeric($position['value'])) {
						$usdValue = (float)$position['value'];
					} elseif (isset($position['value_usd']) && is_numeric($position['value_usd'])) {
						$usdValue = (float)$position['value_usd'];
					}

					if ($usdValue !== null) {
						$result['valueUSD'] += $position['type'] == 'borrow' ? -abs($usdValue) : abs($usdValue);
					}
				}
				break;
				
			case 'hyperion':
				$positionValue = 0;
				
				// Основная стоимость позиции в пуле
				if (isset($position['value']) && $position['value'] > 0) {
					$positionValue = (float)$position['value'];
					$result['message'] .= "  ┣ 💧 LP Position: $" . number_format($positionValue, 2) . "\n";
					$result['valueUSD'] += $positionValue;
				}
				
				// Обработка неполученных комиссий (fees)
				if (isset($position['fees']['unclaimed']) && is_array($position['fees']['unclaimed'])) {
					foreach ($position['fees']['unclaimed'] as $fee) {
						if (isset($fee['amountUSD']) && (float)$fee['amountUSD'] > 0) {
							$feeEmoji = $this->getTokenEmoji($this->getSymbolFromCoin($fee['token'] ?? ''));
							$feeUsd = (float)$fee['amountUSD'];
							$result['message'] .= "  ┃ ┣ {$feeEmoji} Unclaimed Fees: $" . number_format($feeUsd, 2) . "\n";
							$result['valueUSD'] += $feeUsd;
						}
					}
				}
				
				// Обработка неполученных фарминг-наград (farm.unclaimed) - ЭТО И ЕСТЬ REWARDS
				if (isset($position['farm']['unclaimed']) && is_array($position['farm']['unclaimed'])) {
					foreach ($position['farm']['unclaimed'] as $reward) {
						if (isset($reward['amountUSD']) && (float)$reward['amountUSD'] > 0) {
							$rewardEmoji = $this->getTokenEmoji($this->getSymbolFromCoin($reward['token'] ?? ''));
							$rewardUsd = (float)$reward['amountUSD'];
							$result['message'] .= "  ┃ ┗ 🎁 Farm Reward: $" . number_format($rewardUsd, 2) . "\n";
							$result['valueUSD'] += $rewardUsd;
						}
					}
				}
				break;
				
			case 'tapp':
				if (isset($position['estimatedWithdrawals'])) {
					$result['message'] .= "  ┣ 📊 Pool: LP Position\n";
					
					// Estimated Withdrawals (основная позиция)
					foreach ($position['estimatedWithdrawals'] as $withdrawal) {
						if (isset($withdrawal['symbol']) && $withdrawal['amount'] > 0) {
							$emoji = $this->getTokenEmoji($withdrawal['symbol']);
							$amount = number_format((float)$withdrawal['amount'], 2);
							$result['message'] .= "  ┃ ┣ {$emoji} {$withdrawal['symbol']}: `{$amount}`\n";
							
							if (isset($withdrawal['usd']) && $withdrawal['usd'] > 0) {
								$result['valueUSD'] += (float)$withdrawal['usd'];
							} else {
								$result['valueUSD'] += (float)$withdrawal['amount'];
							}
						}
					}
					
					// Estimated Collect Fees (комиссии)
					if (isset($position['estimatedCollectFees']) && is_array($position['estimatedCollectFees'])) {
						foreach ($position['estimatedCollectFees'] as $fee) {
							if (isset($fee['symbol']) && isset($fee['usd']) && $fee['usd'] > 0) {
								$emoji = $this->getTokenEmoji($fee['symbol']);
								$feeUsd = (float)$fee['usd'];
								$result['message'] .= "  ┃ ┣ {$emoji} Pending Fees: $" . number_format($feeUsd, 2) . "\n";
								$result['valueUSD'] += $feeUsd;
							}
						}
					}
					
					// Estimated Incentives (НАГРАДЫ)
					if (isset($position['estimatedIncentives']) && is_array($position['estimatedIncentives'])) {
						foreach ($position['estimatedIncentives'] as $incentive) {
							if (isset($incentive['symbol']) && isset($incentive['usd']) && $incentive['usd'] > 0) {
								$emoji = $this->getTokenEmoji($incentive['symbol']);
								$incentiveUsd = (float)$incentive['usd'];
								$result['message'] .= "  ┃ ┣ 🎯 Incentive: {$emoji} $" . number_format($incentiveUsd, 2) . "\n";
								$result['valueUSD'] += $incentiveUsd;
							}
						}
					}
					
					if (isset($position['feeTier'])) {
						$result['message'] .= "  ┃ ┗ 💸 Fee tier: `{$position['feeTier']}`\n";
					}
				}
				break;
				
			case 'aave':
				if (isset($position['deposit_amount']) && $position['deposit_amount'] > 0) {
					$emoji = $this->getTokenEmoji($position['symbol']);
					$amount = number_format($position['deposit_amount'], 2);
					$value = number_format($position['deposit_value_usd'], 2);
					$result['message'] .= "  ┣ {$emoji} Supplied: `{$amount} {$position['symbol']}`\n";
					$result['message'] .= "  ┃ ┗ 💵 Value: \${$value}\n";
					$result['valueUSD'] += (float)$position['deposit_value_usd'];
				}
				break;
				
			case 'moar':
				if (isset($position['balance'])) {
					$emoji = $this->getTokenEmoji($position['assetName']);
					$amount = number_format($position['balance'] / 1000000, 2);
					$value = number_format($position['value'], 2);
					$result['message'] .= "  ┣ {$emoji} Staked: `{$amount} {$position['assetName']}`\n";
					$result['message'] .= "  ┃ ┗ 💵 Value: \${$value}\n";
					$result['valueUSD'] += (float)$position['value'];
				}
				break;
				
			case 'decibel':
				if (isset($position['size']) && (float)$position['size'] > 0) {
					$size = (float)$position['size'];
					$leverage = (float)($position['user_leverage'] ?? 1);
					$entryPrice = (float)($position['entry_price'] ?? 0);
					$positionValue = ($entryPrice > 0) ? ($size * $entryPrice) / $leverage : $size;
					
					$result['message'] .= "  ┣ 📈 Trading Position\n";
					$result['message'] .= "  ┃ ┣ 📊 Size: `" . number_format($size, 4) . "`\n";
					if ($entryPrice > 0) {
						$result['message'] .= "  ┃ ┣ 💵 Entry Price: $" . number_format($entryPrice, 2) . "\n";
					}
					$result['message'] .= "  ┃ ┣ ⚙️ Leverage: `{$leverage}x`\n";
					
					if (isset($position['unrealized_funding']) && (float)$position['unrealized_funding'] != 0) {
						$pnl = (float)$position['unrealized_funding'];
						$pnlFormatted = number_format(abs($pnl), 2);
						$pnlEmoji = $pnl >= 0 ? '📈' : '📉';
						$result['message'] .= "  ┃ ┗ {$pnlEmoji} Unrealized PnL: " . ($pnl >= 0 ? '+' : '-') . " \${$pnlFormatted}\n";
						$result['valueUSD'] += $pnl;
					} else {
						$result['message'] .= "  ┃ ┗ 💤 No open PnL\n";
					}
					
					$result['valueUSD'] += $positionValue;
				}
				break;

			case 'aptree':
				// Placeholder parser for future APTree payload.
				// Keep protocol visible in formatter flow without strict schema assumptions.
				if (isset($position['valueUSD']) && is_numeric($position['valueUSD'])) {
					$result['valueUSD'] += (float)$position['valueUSD'];
				} elseif (isset($position['value']) && is_numeric($position['value'])) {
					$result['valueUSD'] += (float)$position['value'];
				}
				if ($result['valueUSD'] > 0) {
					$result['message'] .= "  ┣ 💵 Position: $" . number_format($result['valueUSD'], 2) . "\n";
				} else {
					$result['message'] .= "  ┣ 📌 APTree data placeholder\n";
				}
				break;
				
			default:
				if (isset($position['amount'])) {
					$amount = number_format($position['amount'], 2);
					$result['message'] .= "  ┣ 📊 Position: `{$amount}`\n";
					$result['valueUSD'] += (float)$position['amount'];
				}
				break;
		}
		
		return $result;
	}

	/**
	 * formatInvestmentPortfolio($data=[]) 
	 */
	public function formatInvestmentPortfolio($data=[], $walletTotalUsd=0, $previousTotalAssets=null) 
	{
		if (empty($data) || !is_array($data)) {
			$data = [];
		}

		$protocols = [];
		if (!empty($data['protocols']) && is_array($data['protocols'])) {
			$protocols = $data['protocols'];
		}
		$protocolsTotal = isset($data['protocolsTotal']) ? (int)$data['protocolsTotal'] : count($protocols);
		$protocolsWithPositions = isset($data['protocolsWithPositions']) ? (int)$data['protocolsWithPositions'] : 0;
		$failedProtocols = isset($data['failedProtocols']) ? (int)$data['failedProtocols'] : 0;

		$message = "📈 *TOTAL ASSETS INVESTMENT*\n";
		$message .= "\n";
		$message .= "📊 Total Protocols: {$protocolsTotal}\n";
		$message .= "✅ Active: {$protocolsWithPositions}\n";
		if ($failedProtocols > 0) {
			$message .= "❌ Failed: {$failedProtocols}\n";
		}
		$message .= "\n";
		
		$hasAnyPositions = false;
		
		foreach ($protocols as $protocol) {
			if ($protocol['success'] && $protocol['positionsCount'] > 0) {
				$hasAnyPositions = true;
				$emoji = $this->getProtocolEmoji($protocol['protocol']);
				$protocolName = strtolower($protocol['protocol']);
				$protocolTotalValue = 0.0;
				$protocolMessages = '';
				
				foreach ($protocol['positions'] as $position) {
					$array = $this->formatProtocolPosition($protocol['protocol'], $position);
					$protocolMessages .= $array['message'];
					$protocolTotalValue += (float)($array['valueUSD'] ?? 0);
				}

				if ($protocolName === 'echelon') {
					$message .= "\n{$emoji} *" . ucfirst($protocol['protocol']) . ": $" . number_format($protocolTotalValue, 2) . "*\n";
				} else {
					$message .= "\n{$emoji} *" . ucfirst($protocol['protocol']) . "*\n";
				}
				$message .= $protocolMessages;
			}
		}
		
		if (!$hasAnyPositions) {
			$message .= "\n📭 No active positions found\n";
		}
		
		return $message;
	}

	/**
	 * calculateTotalAssetsFromProtocols($data=[])
	 */
	public function calculateTotalAssetsFromProtocols($data=[])
	{
		if (empty($data) || !is_array($data) || empty($data['protocols']) || !is_array($data['protocols'])) {
			return 0.0;
		}

		$totalAssets = 0.0;
		foreach ($data['protocols'] as $protocol) {
			if (empty($protocol['success']) || empty($protocol['positionsCount']) || empty($protocol['positions']) || !is_array($protocol['positions'])) {
				continue;
			}

			$protocolName = !empty($protocol['protocol']) ? $protocol['protocol'] : '';
			foreach ($protocol['positions'] as $position) {
				$array = $this->formatProtocolPosition($protocolName, $position);
				$totalAssets += (float)($array['valueUSD'] ?? 0);
			}
		}

		return $totalAssets;
	}

	/**
	 * getTotalAssetsTrendEmoji($currentTotal=0.0, $previousTotal=null)
	 */
	public function getTotalAssetsTrendEmoji($currentTotal=0.0, $previousTotal=null)
	{
		if ($previousTotal === null || $previousTotal === '' || !is_numeric($previousTotal)) {
			return '';
		}

		$current = (float)$currentTotal;
		$previous = (float)$previousTotal;

		if ($current > $previous) {
			return '📈';
		}
		if ($current < $previous) {
			return '📉';
		}

		return '';
	}

	/**
	 * getTokenEmoji($symbol='') 
	 */
	public function getTokenEmoji($symbol='') 
	{
		if (empty($symbol)) {
			return false;
		}
		
		$emojiMap = [
			'USDC' => '💵',
			'USDT' => '💵',
			'USDt' => '💵', // Tether
			'BTC' => '₿',
			'ETH' => 'Ξ',
			'BNB' => '🟡',
			'SOL' => '◎',
			'MATIC' => '🟣',
			'DAI' => '🟢',
			'APT' => '⛓️', // Aptos blockchain emoji
			'APTO' => '⛓️', // Alternative for Aptos
			'kAPT' => '🔷', // или другой отличительный знак
		];
		
		return $emojiMap[strtoupper($symbol)] ?? '💎';
	}
	
	/**
	 * getProtocolEmoji($protocol)
	 */
	public function getProtocolEmoji($protocol='') 
	{
		$emojiMap = [
			'echelon' => '📊',
			'aries' => '♈',
			'joule' => '⚡',
			'tapp' => '💧',
			'meso' => '🌐',
			'auro' => '✨',
			'amnis' => '🌊',
			'earnium' => '💰',
			'aave' => '🌿',
			'moar' => '🔥',
			'thala' => '🌴',
			'echo' => '🔊',
			'hyperion' => '🌌',
			'decibel' => '📢',
			'aptree' => '🌳',
		];
		
		return $emojiMap[strtolower($protocol)] ?? '📦';
	}
	
	/**
	 * getSymbolFromCoin($coinAddress='')
	 */
	public function getSymbolFromCoin($coinAddress='') 
	{
		// This is a simplified version - in production you'd want a proper mapping
		$symbolMap = [
			'0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b' => 'USDC',
			'0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b' => 'USDT',
			'0x05fabd1b12e39967a3c24e91b7b8f67719a6dacee74f3c8b9fb7d93e855437d2' => 'USD1',
			'0x1::aptos_coin::AptosCoin' => 'APT',
		];
		
		return $symbolMap[$coinAddress] ?? 'Unknown';
	}
	
	/**
	 * getData($data=[])
	 */
	public function getBalance($address='')
	{
		if (empty($address)) {
			return false;
		}
		
		$api_url = $this->YieldaiApiUrl . urlencode($address) . '/balance?api_key='.$this->api_key;

		$ch = curl_init($api_url);
		curl_setopt_array($ch, [
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_TIMEOUT => 30,
			CURLOPT_HTTPHEADER => [
				'Accept: application/json',
			],
		]);

		$response = curl_exec($ch);
		$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

		if ($response === false) {
			return false;;
		}
		
		curl_close($ch);

		$data = json_decode($response, true);

		if (!is_array($data)) {
			return false;
		}

		return $data;
	}
	
	/**
	 * getData($data=[])
	 */
	public function getProtocols($address='')
	{
	if (empty($address)) {
			return false;
		}
		
		$api_url = $this->YieldaiApiUrl . urlencode($address) . '/protocols?api_key='.$this->api_key;

		$ch = curl_init($api_url);
		curl_setopt_array($ch, [
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_TIMEOUT => 30,
			CURLOPT_HTTPHEADER => [
				'Accept: application/json',
			],
		]);

		$response = curl_exec($ch);
		$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

		if ($response === false) {
			return false;;
		}
		
		curl_close($ch);

		$data = json_decode($response, true);

		if (!is_array($data)) {
			return false;
		}

		return $data;
	}
	
	/**
	 * sendData($data= [], $token='')
	 */
	public function sendData($data= [], $token='')
	{
		if (empty($data) || !is_array($data) || empty($token)) {
			return false;
		}
		
		$url = $this->TelegramBotApiUrl . $token . '/sendMessage';
		
		return $this->sendDataToBot($url, $data);
	}
	
	/**
	 * sendActionToBot($botUrl) 
	 */
	public function sendActionToBot($botUrl='') 
	{
		if (empty($botUrl) || !is_string($botUrl)) {
			return null;
		}
		$ch = curl_init();
		curl_setopt_array($ch, [
			CURLOPT_HEADER => false,
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_URL => $botUrl,
			CURLOPT_POST => true,
			CURLOPT_HTTPHEADER => ["Content-Type: application/json"],
		]);
		$result = curl_exec($ch);
		curl_close($ch);
		return json_decode($result, true);
	}
	
	/**
	 * sendDataToBot($botUrl, $data) 
	 */
	public static function sendDataToBot($botUrl, $data) 
	{
		if (empty($botUrl) || !is_string($botUrl)) {
			return false;
		}
		if (empty($data) || !is_array($data)) {
			return false;
		}
		$ch = curl_init();
		curl_setopt_array($ch, [
			CURLOPT_HEADER => false,
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_URL => $botUrl,
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => json_encode($data),
			CURLOPT_HTTPHEADER => ["Content-Type: application/json"],
		]);
		$result = curl_exec($ch);		
		curl_close($ch);
		return json_decode($result, true);
	}
	
	/**
	 * getDataTGBot($bot_name='') 
	 */
	public function getDataTGBot($id_bot=0) 
	{
		if (empty($id_bot)) {
			return false;
		}
		
		$sql = '
			SELECT
				`id_bot`,
				`bot_token`,
				`bot_name`,
				`bot_identify`
			FROM `001_chatbot` 
			WHERE `id_bot` = :id_bot
			AND `deleted` = 0
			LIMIT 1
		';
		
		$params = [
			':id_bot' => $id_bot,
		];

		$result = $this->queryParams($sql, $params, 'fetch');
		
		if (!empty($result) && !empty($result['completed']) && !empty($result['completed']['id_bot']) && !empty($result['completed']['bot_token'])) {
			return [
				'id_bot'=>$result['completed']['id_bot'],
				'bot_token' => $result['completed']['bot_token'],
				'bot_name' => $result['completed']['bot_name'],
				'bot_identify' => $result['completed']['bot_identify'],
			];
		}
	
		return false;	
	}
	
	/**
	 * queryParams($sql, $params, $type='fetch')
	 */
	public function queryParams($sql, $params, $type=false)
	{
		if (!is_array($params)) {
			return false;
		}
		
		$this->DBConnection();

		try {
			
			$connection = $this->connection;
			$query = $connection->prepare($sql);

			if (!empty($type)) {
				$query->execute($params);
				$result = $query->$type();
			} else {
				$result = $query->execute($params);
			}
			
			$info = $query->errorInfo();		
			
		} catch (PDOException $e) {
			
			$info = $e->getMessage();
			$result = false;	
			
		}

		return [
			'info' => $info,
			'completed' => $result,
		];
	}
	
	/**
	 * connection()
	 */
	private function DBConnection()
	{
		$config = $this->getConfig();

		try {
			$this->connection = new PDO('mysql:host=' . $config['host'] . ';port=' . $config['port'] . ';dbname=' . $config['dbname'] . ';charset='.$config['charset'], $config['user'], $config['pass']);
			$this->connection->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
		} catch (PDOException $e) {
			die($e->getMessage());
		}

		$this->connection->exec('set names '.$config['charset']);
		
		return;
	}
	
	/** 
	 * getConfig()
	 */
	private function getConfig()
	{
		return [
			'host' => 'localhost',
			'user' => '001_yieldai_usr',
			'pass' => 'Gb3zqERQn8wShCWJiVOi',
			'dbname' => '001_yieldaiapi_db',
			'charset' => 'utf8mb4',
			'port' => '',
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