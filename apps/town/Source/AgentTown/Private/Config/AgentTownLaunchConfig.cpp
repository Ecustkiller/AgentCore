#include "Config/AgentTownLaunchConfig.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformMisc.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

static bool TryLoadSessionJson(FString& OutApiBase, FString& OutToken)
{
	const FString SessionPath = FPaths::Combine(
		FPlatformMisc::GetEnvironmentVariable(TEXT("APPDATA")),
		TEXT("AgentCore"),
		TEXT("session.json"));

	FString JsonText;
	if (!FFileHelper::LoadFileToString(JsonText, *SessionPath))
	{
		return false;
	}

	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	bool bFound = false;
	FString ApiBase;
	if (Root->TryGetStringField(TEXT("api_base"), ApiBase) && !ApiBase.IsEmpty())
	{
		OutApiBase = ApiBase;
		bFound = true;
	}

	FString Token;
	if (Root->TryGetStringField(TEXT("access_token"), Token) && !Token.IsEmpty())
	{
		OutToken = Token;
		bFound = true;
	}

	return bFound;
}

FAgentTownLaunchConfig FAgentTownLaunchConfig::Load()
{
	FAgentTownLaunchConfig Config;

	FParse::Value(FCommandLine::Get(), TEXT("api="), Config.ApiBase);
	FParse::Value(FCommandLine::Get(), TEXT("token="), Config.AccessToken);
	FParse::Value(FCommandLine::Get(), TEXT("run-id="), Config.RunId);

	FString SessionApi;
	FString SessionToken;
	if (TryLoadSessionJson(SessionApi, SessionToken))
	{
		if (Config.ApiBase == TEXT("http://localhost:8000") && !SessionApi.IsEmpty())
		{
			Config.ApiBase = SessionApi;
		}
		if (Config.AccessToken.IsEmpty() && !SessionToken.IsEmpty())
		{
			Config.AccessToken = SessionToken;
		}
	}

	return Config;
}
