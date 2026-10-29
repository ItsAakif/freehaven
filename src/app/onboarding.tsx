import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  AppText,
  Card,
  Button,
  Field,
  Chip,
  ProgressBar,
  Header,
} from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { saveProfile, type Familiarity } from '@/data/repositories/profile';
import { usePreferences } from '@/state/preferences';

const TOPICS = [
  'philosophy',
  'psychology',
  'science',
  'economics',
  'history',
  'business',
  'health',
  'writing',
];

const GOAL_SUGGESTIONS = [
  'Think more clearly',
  'Understand how habits work',
  'Learn economics from scratch',
  'Read the classics with guidance',
];

const FAMILIARITY: { id: Familiarity; label: string; hint: string }[] = [
  { id: 'new', label: 'New', hint: 'Start at the beginning' },
  { id: 'some', label: 'Some', hint: 'I know the basics' },
  { id: 'confident', label: 'Confident', hint: 'Skip the intro' },
];

export default function OnboardingScreen() {
  const { palette } = useTheme();
  const setDailyGoal = usePreferences((s) => s.setDailyGoalMinutes);
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [familiarity, setFamiliarity] = useState<Record<string, Familiarity>>({});
  const [minutes, setMinutes] = useState(15);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTopic = (topic: string) => {
    setTopics((current) =>
      current.includes(topic) ? current.filter((t) => t !== topic) : [...current, topic],
    );
    setFamiliarity((current) => {
      if (current[topic]) {
        const { [topic]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [topic]: 'some' };
    });
  };

  const finish = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveProfile({
        goal: goal.trim() || null,
        topics,
        familiarity,
        minutesPerDay: minutes,
        onboardingComplete: true,
      });
      setDailyGoal(minutes);
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const canContinue =
    step === 0
      ? true
      : step === 1
        ? true
        : step === 2
          ? topics.length === 0 || topics.every((t) => familiarity[t])
          : true;

  return (
    <Screen>
      <Header
        title="Set up Freehaven"
        subtitle="Three questions, then you can start."
        onBack={step > 0 ? () => setStep(step - 1) : undefined}
      />
      <ProgressBar value={(step + 1) / 4} />
      <AppText variant="caption" faint>
        Step {step + 1} of 4
      </AppText>

      {step === 0 ? (
        <View style={{ gap: space.md }}>
          <AppText variant="heading" serif>
            What do you want to understand?
          </AppText>
          <Field
            value={goal}
            onChangeText={setGoal}
            placeholder="e.g. how attention and focus work"
            multiline={false}
            accessibilityLabel="Your learning goal"
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {GOAL_SUGGESTIONS.map((suggestion) => (
              <Chip key={suggestion} label={suggestion} active={goal === suggestion} onPress={() => setGoal(suggestion)} />
            ))}
          </View>
          <AppText variant="caption" faint>
            This shapes recommendations and path order. You can change it later in Settings.
          </AppText>
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ gap: space.md }}>
          <AppText variant="heading" serif>
            Which subjects?
          </AppText>
          <AppText variant="caption" muted>
            Pick at least one. Freehaven uses these to order your reading and group mastery.
          </AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {TOPICS.map((topic) => (
              <Chip key={topic} label={topic} active={topics.includes(topic)} onPress={() => toggleTopic(topic)} />
            ))}
          </View>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: space.md }}>
          <AppText variant="heading" serif>
            How familiar are you?
          </AppText>
          <AppText variant="caption" muted>
            This is a self-assessment. It decides which books come first — nothing is locked.
          </AppText>
          {topics.map((topic) => (
            <Card key={topic} style={{ gap: space.sm }}>
              <AppText variant="bodySm" style={{ textTransform: 'capitalize', fontWeight: '600' }}>
                {topic}
              </AppText>
              <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                {FAMILIARITY.map((option) => (
                  <Chip
                    key={option.id}
                    label={option.label}
                    active={familiarity[topic] === option.id}
                    onPress={() => setFamiliarity((c) => ({ ...c, [topic]: option.id }))}
                  />
                ))}
              </View>
              <AppText variant="caption" faint>
                {FAMILIARITY.find((f) => f.id === familiarity[topic])?.hint ?? ''}
              </AppText>
            </Card>
          ))}
        </View>
      ) : null}

      {step === 3 ? (
        <View style={{ gap: space.md }}>
          <AppText variant="heading" serif>
            How much time each day?
          </AppText>
          <AppText variant="caption" muted>
            A target, not a streak trap. You can change it any time.
          </AppText>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {[10, 15, 20, 30].map((value) => (
              <Chip key={value} label={`${value} min`} active={minutes === value} onPress={() => setMinutes(value)} />
            ))}
          </View>
          <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.accentSoft }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: radius.md,
                  backgroundColor: palette.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="leaf-outline" size={20} color={palette.accent} />
              </View>
              <AppText variant="bodySm" style={{ flex: 1 }}>
                {minutes} minutes a day is about {Math.max(4, Math.round(minutes * 0.9))} pages, or one short chapter.
                Reviews count toward it.
              </AppText>
            </View>
          </Card>
          {error ? (
            <AppText variant="caption" color={palette.danger}>
              {error}
            </AppText>
          ) : null}
        </View>
      ) : null}

      <Button
        label={step === 3 ? 'Start learning' : 'Continue'}
        onPress={() => {
          if (step === 3) void finish();
          else setStep(step + 1);
        }}
        disabled={!canContinue}
        loading={saving}
        full
      />
      {step < 3 ? (
        <Button
          label="Skip for now"
          variant="ghost"
          onPress={() => {
            if (step === 0) setStep(1);
            else if (step === 1) setStep(2);
            else setStep(3);
          }}
        />
      ) : null}
    </Screen>
  );
}
