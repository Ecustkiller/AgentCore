#include "Simulation/SimSnapshotParser.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

bool FSimSnapshotParser::ParseVec3(const TSharedPtr<FJsonObject>& VecObj, FWireVec3& OutVec)
{
	if (!VecObj.IsValid())
	{
		return false;
	}

	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;
	VecObj->TryGetNumberField(TEXT("x"), X);
	VecObj->TryGetNumberField(TEXT("y"), Y);
	VecObj->TryGetNumberField(TEXT("z"), Z);
	OutVec = FWireVec3(X, Y, Z);
	return true;
}

bool FSimSnapshotParser::ParseAgentState(const TSharedPtr<FJsonObject>& AgentObj, FSimAgentState& OutAgent)
{
	if (!AgentObj.IsValid())
	{
		return false;
	}

	AgentObj->TryGetStringField(TEXT("agent_id"), OutAgent.AgentId);
	AgentObj->TryGetStringField(TEXT("name"), OutAgent.Name);
	AgentObj->TryGetStringField(TEXT("role"), OutAgent.Role);
	AgentObj->TryGetStringField(TEXT("location"), OutAgent.Location);

	const TSharedPtr<FJsonObject>* PosObj = nullptr;
	if (AgentObj->TryGetObjectField(TEXT("position"), PosObj))
	{
		ParseVec3(*PosObj, OutAgent.Position);
	}

	return !OutAgent.AgentId.IsEmpty();
}

bool FSimSnapshotParser::ParseTickSnapshot(const TSharedPtr<FJsonObject>& Root, FSimTickSnapshot& OutSnapshot)
{
	if (!Root.IsValid())
	{
		return false;
	}

	Root->TryGetNumberField(TEXT("tick"), OutSnapshot.Tick);
	Root->TryGetNumberField(TEXT("hour"), OutSnapshot.Hour);

	const TSharedPtr<FJsonObject>* AgentsObj = nullptr;
	if (!Root->TryGetObjectField(TEXT("agents"), AgentsObj) || !AgentsObj->IsValid())
	{
		return true;
	}

	OutSnapshot.Agents.Reset();
	for (const TPair<FString, TSharedPtr<FJsonValue>>& Entry : (*AgentsObj)->Values)
	{
		const TSharedPtr<FJsonObject>* AgentObj = nullptr;
		if (!Entry.Value->TryGetObject(AgentObj) || !AgentObj->IsValid())
		{
			continue;
		}

		FSimAgentState Agent;
		if (ParseAgentState(*AgentObj, Agent))
		{
			if (Agent.AgentId.IsEmpty())
			{
				Agent.AgentId = Entry.Key;
			}
			OutSnapshot.Agents.Add(Agent.AgentId, Agent);
		}
	}

	return true;
}

bool FSimSnapshotParser::ParseCreateRunResponse(const FString& JsonText, FSimCreateRunResult& OutResult)
{
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	Root->TryGetStringField(TEXT("id"), OutResult.Id);
	Root->TryGetStringField(TEXT("scenario"), OutResult.Scenario);
	Root->TryGetStringField(TEXT("status"), OutResult.Status);
	Root->TryGetNumberField(TEXT("seed"), OutResult.Seed);
	Root->TryGetNumberField(TEXT("current_tick"), OutResult.CurrentTick);
	return !OutResult.Id.IsEmpty();
}

bool FSimSnapshotParser::ParseAdvanceTickResponse(const FString& JsonText, FSimAdvanceTickResult& OutResult)
{
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	Root->TryGetStringField(TEXT("run_id"), OutResult.RunId);

	const TSharedPtr<FJsonObject>* SnapshotObj = nullptr;
	if (Root->TryGetObjectField(TEXT("snapshot"), SnapshotObj) && SnapshotObj->IsValid())
	{
		(*SnapshotObj)->TryGetNumberField(TEXT("tick"), OutResult.Tick);
	}

	return OutResult.Tick > 0 || !OutResult.RunId.IsEmpty();
}

bool FSimSnapshotParser::ParseTickFrameResponse(const FString& JsonText, FSimTickFrameResult& OutResult)
{
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	Root->TryGetStringField(TEXT("run_id"), OutResult.RunId);
	Root->TryGetNumberField(TEXT("tick_number"), OutResult.TickNumber);

	const TSharedPtr<FJsonObject>* SnapshotObj = nullptr;
	if (!Root->TryGetObjectField(TEXT("snapshot"), SnapshotObj) || !SnapshotObj->IsValid())
	{
		return false;
	}

	return ParseTickSnapshot(*SnapshotObj, OutResult.Snapshot);
}

static bool ParseBigFive(const TSharedPtr<FJsonObject>& Obj, FSimBigFive& OutBigFive)
{
	if (!Obj.IsValid())
	{
		return false;
	}

	Obj->TryGetNumberField(TEXT("openness"), OutBigFive.Openness);
	Obj->TryGetNumberField(TEXT("conscientiousness"), OutBigFive.Conscientiousness);
	Obj->TryGetNumberField(TEXT("extraversion"), OutBigFive.Extraversion);
	Obj->TryGetNumberField(TEXT("agreeableness"), OutBigFive.Agreeableness);
	Obj->TryGetNumberField(TEXT("neuroticism"), OutBigFive.Neuroticism);
	return true;
}

static bool ParsePersona(const TSharedPtr<FJsonObject>& Obj, FSimPersona& OutPersona)
{
	if (!Obj.IsValid())
	{
		return false;
	}

	Obj->TryGetStringField(TEXT("agent_id"), OutPersona.AgentId);
	Obj->TryGetStringField(TEXT("name"), OutPersona.Name);
	Obj->TryGetStringField(TEXT("role"), OutPersona.Role);
	Obj->TryGetStringField(TEXT("location"), OutPersona.Location);
	Obj->TryGetStringField(TEXT("goal"), OutPersona.Goal);

	const TSharedPtr<FJsonObject>* BigFiveObj = nullptr;
	if (Obj->TryGetObjectField(TEXT("big_five"), BigFiveObj))
	{
		ParseBigFive(*BigFiveObj, OutPersona.BigFive);
	}

	return !OutPersona.AgentId.IsEmpty();
}

bool FSimSnapshotParser::ParseManifestResponse(const FString& JsonText, FSimManifestResult& OutResult)
{
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	Root->TryGetStringField(TEXT("run_id"), OutResult.RunId);

	const TSharedPtr<FJsonObject>* ManifestObj = nullptr;
	if (!Root->TryGetObjectField(TEXT("manifest"), ManifestObj) || !ManifestObj->IsValid())
	{
		return false;
	}

	const TSharedPtr<FJsonObject>& Manifest = *ManifestObj;
	Manifest->TryGetStringField(TEXT("manifest_version"), OutResult.Manifest.ManifestVersion);
	Manifest->TryGetStringField(TEXT("scenario"), OutResult.Manifest.Scenario);
	Manifest->TryGetNumberField(TEXT("seed"), OutResult.Manifest.Seed);

	const TArray<TSharedPtr<FJsonValue>>* PersonasArr = nullptr;
	if (Manifest->TryGetArrayField(TEXT("personas"), PersonasArr))
	{
		OutResult.Manifest.Personas.Reset();
		for (const TSharedPtr<FJsonValue>& Value : *PersonasArr)
		{
			const TSharedPtr<FJsonObject>* PersonaObj = nullptr;
			if (!Value->TryGetObject(PersonaObj) || !PersonaObj->IsValid())
			{
				continue;
			}

			FSimPersona Persona;
			if (ParsePersona(*PersonaObj, Persona))
			{
				OutResult.Manifest.Personas.Add(Persona);
			}
		}
	}

	const TArray<TSharedPtr<FJsonValue>>* RegionsArr = nullptr;
	if (Manifest->TryGetArrayField(TEXT("regions"), RegionsArr))
	{
		OutResult.Manifest.Regions.Reset();
		for (const TSharedPtr<FJsonValue>& Value : *RegionsArr)
		{
			FString Region;
			if (Value->TryGetString(Region))
			{
				OutResult.Manifest.Regions.Add(Region);
			}
		}
	}

	return !OutResult.RunId.IsEmpty();
}

bool FSimSnapshotParser::ParseSseEventJson(const FString& JsonText, FSimSseEvent& OutEvent)
{
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	Root->TryGetStringField(TEXT("type"), OutEvent.Type);
	Root->TryGetStringField(TEXT("timestamp"), OutEvent.Timestamp);

	const TSharedPtr<FJsonObject>* PayloadObj = nullptr;
	if (Root->TryGetObjectField(TEXT("payload"), PayloadObj) && PayloadObj->IsValid())
	{
		OutEvent.Payload = *PayloadObj;
	}
	else
	{
		OutEvent.Payload = MakeShared<FJsonObject>();
	}

	return !OutEvent.Type.IsEmpty();
}
